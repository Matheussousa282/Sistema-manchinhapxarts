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

      // Insere o recebimento
      await client.query(
        `INSERT INTO recebimentos (pedido_id, forma, valor, observacao, usuario)
         VALUES ($1, $2, $3, $4, $5)`,
        [pedido_id, forma, valor, observacao || '', usuario || '']
      );

      // Atualiza valor_recebido e status no pedido
      await client.query(
        `UPDATE pedidos SET valor_recebido = $1, status = $2 WHERE id = $3`,
        [novo_valor_recebido, novo_status, pedido_id]
      );

      return res.status(201).json({ message: 'Recebimento registrado com sucesso!' });
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
