import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function inicializar(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS caixa_lancamentos (
      id          SERIAL PRIMARY KEY,
      data        DATE          NOT NULL DEFAULT CURRENT_DATE,
      tipo        VARCHAR(10)   NOT NULL CHECK (tipo IN ('entrada','saida')),
      forma       VARCHAR(60)   NOT NULL,
      valor       NUMERIC(10,2) NOT NULL,
      descricao   TEXT          DEFAULT '',
      usuario     VARCHAR(100)  DEFAULT '',
      criado_em   TIMESTAMP     DEFAULT NOW()
    )
  `);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const client = await pool.connect();

  try {
    await inicializar(client);

    // ── GET /api/caixa?data=YYYY-MM-DD
    // Retorna lançamentos do dia + resumo por forma
    if (req.method === 'GET') {
      const { data } = req.query;
      const dataFiltro = data || new Date().toISOString().slice(0, 10);

      // Lançamentos do dia
      const lancs = await client.query(
        `SELECT * FROM caixa_lancamentos WHERE data = $1 ORDER BY criado_em ASC`,
        [dataFiltro]
      );

      // Resumo por forma (só entradas)
      const resumo = await client.query(
        `SELECT forma, SUM(valor) AS total
         FROM caixa_lancamentos
         WHERE data = $1 AND tipo = 'entrada'
         GROUP BY forma
         ORDER BY total DESC`,
        [dataFiltro]
      );

      // Totais gerais
      const totais = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor ELSE 0 END), 0) AS entradas,
           COALESCE(SUM(CASE WHEN tipo='saida'   THEN valor ELSE 0 END), 0) AS saidas
         FROM caixa_lancamentos
         WHERE data = $1`,
        [dataFiltro]
      );

      return res.status(200).json({
        lancamentos: lancs.rows,
        resumo_formas: resumo.rows,
        entradas: Number(totais.rows[0].entradas),
        saidas:   Number(totais.rows[0].saidas),
        saldo:    Number(totais.rows[0].entradas) - Number(totais.rows[0].saidas),
        data:     dataFiltro
      });
    }

    // ── POST /api/caixa — Adicionar lançamento
    if (req.method === 'POST') {
      const { tipo, forma, valor, descricao, usuario, data } = req.body;

      if (!tipo || !forma || !valor) {
        return res.status(400).json({ error: 'tipo, forma e valor são obrigatórios.' });
      }

      const dataLanc = data || new Date().toISOString().slice(0, 10);

      const result = await client.query(
        `INSERT INTO caixa_lancamentos (data, tipo, forma, valor, descricao, usuario)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [dataLanc, tipo, forma, Number(valor), descricao || '', usuario || '']
      );

      return res.status(201).json({ message: 'Lançamento registrado!', lancamento: result.rows[0] });
    }

    // ── DELETE /api/caixa?id=X — Remover lançamento
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'ID obrigatório.' });

      await client.query(`DELETE FROM caixa_lancamentos WHERE id = $1`, [id]);
      return res.status(200).json({ message: 'Lançamento removido.' });
    }

    return res.status(405).json({ error: 'Método não permitido.' });

  } catch (err) {
    console.error('Erro no caixa:', err);
    return res.status(500).json({ error: 'Erro interno.', details: err.message });
  } finally {
    client.release();
  }
}
