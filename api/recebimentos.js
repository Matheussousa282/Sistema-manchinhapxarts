import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Cria tabela de recebimentos se não existir
async function inicializarTabela(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS recebimentos (
      id           SERIAL PRIMARY KEY,
      pedido_id    INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      forma        VARCHAR(50)  NOT NULL,
      valor        NUMERIC(10,2) NOT NULL,
      observacao   TEXT DEFAULT '',
      usuario      VARCHAR(100) DEFAULT '',
      criado_em    TIMESTAMP DEFAULT NOW()
    )
  `);
}

export default async function handler(req, res) {
  const client = await pool.connect();

  try {
    await inicializarTabela(client);

    // ── GET /api/recebimentos?pedido_id=X — Histórico de um pedido
    if (req.method === 'GET') {
      const { pedido_id } = req.query;

      if (pedido_id) {
        const result = await client.query(
          `SELECT * FROM recebimentos WHERE pedido_id = $1 ORDER BY criado_em ASC`,
          [pedido_id]
        );
        return res.status(200).json(result.rows);
      }

      // Sem filtro: retorna todos (para relatórios)
      const result = await client.query(
        `SELECT r.*, p.nome_cliente, p.vendedor, p.telefone_cliente
         FROM recebimentos r
         LEFT JOIN pedidos p ON p.id = r.pedido_id
         ORDER BY r.criado_em DESC`
      );
      return res.status(200).json(result.rows);
    }

    // ── POST /api/recebimentos — Registrar recebimento
    if (req.method === 'POST') {
      const { pedido_id, forma, valor, observacao, usuario, novo_status, novo_valor_recebido } = req.body;

      if (!pedido_id || !forma || !valor) {
        return res.status(400).json({ error: 'pedido_id, forma e valor são obrigatórios.' });
      }

      // Garante que a tabela caixa existe
      await client.query(`
        CREATE TABLE IF NOT EXISTS caixa_lancamentos (
          id          SERIAL PRIMARY KEY,
          data        DATE          NOT NULL DEFAULT CURRENT_DATE,
          tipo        VARCHAR(10)   NOT NULL CHECK (tipo IN ('entrada','saida')),
          forma       VARCHAR(60)   NOT NULL,
          valor       NUMERIC(10,2) NOT NULL,
          descricao   TEXT          DEFAULT '',
          categoria   VARCHAR(100)  DEFAULT '',
          usuario     VARCHAR(100)  DEFAULT '',
          criado_em   TIMESTAMP     DEFAULT NOW()
        )
      `);
      await client.query(`
        ALTER TABLE caixa_lancamentos ADD COLUMN IF NOT EXISTS categoria VARCHAR(100) DEFAULT ''
      `).catch(() => {});

      // Busca nome do cliente para a descricao
      const pedidoInfo = await client.query(
        `SELECT nome_cliente FROM pedidos WHERE id = $1`, [pedido_id]
      );
      const nomeCliente = pedidoInfo.rows[0]?.nome_cliente || '';

      // Data atual no fuso de Fortaleza
      const dataHoje = new Intl.DateTimeFormat('pt-BR', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        timeZone: 'America/Fortaleza'
      }).format(new Date()).split('/').reverse().join('-');

      // Insere o recebimento
      const recResult = await client.query(
        `INSERT INTO recebimentos (pedido_id, forma, valor, observacao, usuario)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [pedido_id, forma, valor, observacao || '', usuario || '']
      );
      const recebimentoId = recResult.rows[0].id;

      // Atualiza valor_recebido e status no pedido
      await client.query(
        `UPDATE pedidos SET valor_recebido = $1, status = $2 WHERE id = $3`,
        [novo_valor_recebido, novo_status, pedido_id]
      );

      // Salva no caixa automaticamente (upsert por recebimento_id para evitar duplicata)
      await client.query(`
        INSERT INTO caixa_lancamentos (data, tipo, forma, valor, descricao, categoria, usuario)
        SELECT $1, 'entrada', $2, $3, $4, 'Recebimento', $5
        WHERE NOT EXISTS (
          SELECT 1 FROM caixa_lancamentos
          WHERE descricao = $4 AND data = $1 AND valor = $3 AND forma = $2
            AND criado_em > NOW() - INTERVAL '5 seconds'
        )
      `, [
        dataHoje,
        forma,
        valor,
        `Recebimento pedido #${pedido_id} — ${nomeCliente}`,
        usuario || ''
      ]);

      return res.status(201).json({ message: 'Recebimento registrado com sucesso!', recebimento_id: recebimentoId });
    }

    // ── DELETE /api/recebimentos?id=X — Remover recebimento (estorno)
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'ID obrigatório.' });

      // Busca recebimento para reverter o valor no pedido
      const rec = await client.query(`SELECT * FROM recebimentos WHERE id = $1`, [id]);
      if (!rec.rows.length) return res.status(404).json({ error: 'Recebimento não encontrado.' });

      const { pedido_id, valor } = rec.rows[0];

      // Subtrai valor do pedido
      await client.query(
        `UPDATE pedidos SET valor_recebido = GREATEST(0, valor_recebido - $1) WHERE id = $2`,
        [valor, pedido_id]
      );

      await client.query(`DELETE FROM recebimentos WHERE id = $1`, [id]);
      return res.status(200).json({ message: 'Recebimento estornado com sucesso!' });
    }

    return res.status(405).json({ error: 'Método não permitido.' });

  } catch (err) {
    console.error('Erro na API de recebimentos:', err);
    return res.status(500).json({ error: 'Erro interno do servidor.', details: err.message });
  } finally {
    client.release();
  }
}
