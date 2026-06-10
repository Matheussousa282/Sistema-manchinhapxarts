// ================================================================
//  api/caixa.js  —  Fluxo de Caixa Mpx Arts
//
//  Rotas:
//    GET    /api/caixa?data=YYYY-MM-DD  → lançamentos + resumo
//    POST   /api/caixa                  → adicionar lançamento
//    DELETE /api/caixa?id=X             → remover lançamento
//
//  Rotas de caixa (abertura/fechamento):
//    GET    /api/caixa/status?data=X    → status do caixa no dia
//    POST   /api/caixa/fechar           → fechar caixa do dia
// ================================================================

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Inicializar tabelas ──────────────────────────────────────
async function inicializar(client) {
  // Tabela de lançamentos
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

  // Tabela de abertura/fechamento de caixa
  await client.query(`
    CREATE TABLE IF NOT EXISTS caixa_registros (
      id              SERIAL PRIMARY KEY,
      data            DATE          NOT NULL UNIQUE,
      fundo_inicial   NUMERIC(10,2) DEFAULT 0,
      saldo_final     NUMERIC(10,2),
      operador        VARCHAR(100)  DEFAULT '',
      status          VARCHAR(20)   NOT NULL DEFAULT 'aberto'
        CHECK (status IN ('aberto','fechado')),
      aberto_em       TIMESTAMP     DEFAULT NOW(),
      fechado_em      TIMESTAMP
    )
  `);

  // Migração: adicionar coluna categoria se não existir
  await client.query(`
    ALTER TABLE caixa_lancamentos
    ADD COLUMN IF NOT EXISTS categoria VARCHAR(100) DEFAULT ''
  `).catch(() => {});
}

// ── Helper: dia atual no fuso de Fortaleza ───────────────────
function diaHoje() {
  return new Intl.DateTimeFormat('pt-BR', {
    year:'numeric', month:'2-digit', day:'2-digit',
    timeZone:'America/Fortaleza'
  }).format(new Date()).split('/').reverse().join('-');
}

// ── Handler principal ────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // Roteamento para sub-rotas
  const url = req.url || '';

  // POST /api/caixa/fechar
  if (req.method === 'POST' && url.includes('/fechar')) {
    return await rotaFechar(req, res);
  }

  // GET /api/caixa/status
  if (req.method === 'GET' && url.includes('/status')) {
    return await rotaStatus(req, res);
  }

  const client = await pool.connect();

  try {
    await inicializar(client);

    // ── GET /api/caixa?data=YYYY-MM-DD ─────────────────────
    if (req.method === 'GET') {
      const dataFiltro = req.query?.data || diaHoje();

      // Lançamentos do dia com ordenação
      const lancs = await client.query(
        `SELECT * FROM caixa_lancamentos
         WHERE data = $1
         ORDER BY criado_em ASC`,
        [dataFiltro]
      );

      // Resumo por forma (entradas)
      const resumo = await client.query(
        `SELECT forma,
                SUM(valor)::float   AS total,
                COUNT(*)::int       AS qtd
         FROM caixa_lancamentos
         WHERE data = $1 AND tipo = 'entrada'
         GROUP BY forma
         ORDER BY total DESC`,
        [dataFiltro]
      );

      // Resumo por categoria
      const porCategoria = await client.query(
        `SELECT categoria,
                tipo,
                SUM(valor)::float AS total,
                COUNT(*)::int     AS qtd
         FROM caixa_lancamentos
         WHERE data = $1
         GROUP BY categoria, tipo
         ORDER BY total DESC`,
        [dataFiltro]
      );

      // Totais gerais
      const totais = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor ELSE 0 END), 0)::float AS entradas,
           COALESCE(SUM(CASE WHEN tipo='saida'   THEN valor ELSE 0 END), 0)::float AS saidas,
           COUNT(CASE WHEN tipo='entrada' THEN 1 END)::int AS cnt_entradas,
           COUNT(CASE WHEN tipo='saida'   THEN 1 END)::int AS cnt_saidas
         FROM caixa_lancamentos
         WHERE data = $1`,
        [dataFiltro]
      );

      // Status do caixa no dia
      const registro = await client.query(
        `SELECT * FROM caixa_registros WHERE data = $1`,
        [dataFiltro]
      );

      const t = totais.rows[0];

      return res.status(200).json({
        data:             dataFiltro,
        lancamentos:      lancs.rows,
        resumo_formas:    resumo.rows,
        por_categoria:    porCategoria.rows,
        entradas:         t.entradas,
        saidas:           t.saidas,
        saldo:            t.entradas - t.saidas,
        cnt_entradas:     t.cnt_entradas,
        cnt_saidas:       t.cnt_saidas,
        caixa_status:     registro.rows[0] || null,
      });
    }

    // ── POST /api/caixa — Adicionar lançamento ─────────────
    if (req.method === 'POST') {
      const { tipo, forma, valor, descricao, categoria, usuario, data } = req.body || {};

      if (!tipo || !forma || !valor) {
        return res.status(400).json({ error: 'tipo, forma e valor são obrigatórios.' });
      }

      const dataLanc = data || diaHoje();

      const result = await client.query(
        `INSERT INTO caixa_lancamentos
           (data, tipo, forma, valor, descricao, categoria, usuario)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          dataLanc, tipo, forma, Number(valor),
          descricao  || '',
          categoria  || '',
          usuario    || ''
        ]
      );

      return res.status(201).json({
        message:     'Lançamento registrado!',
        lancamento:  result.rows[0]
      });
    }

    // ── DELETE /api/caixa?id=X — Remover lançamento ────────
    if (req.method === 'DELETE') {
      const id = req.query?.id;
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

// ── Rota: fechar caixa ────────────────────────────────────────
async function rotaFechar(req, res) {
  const client = await pool.connect();
  try {
    await inicializar(client);
    const { data, saldo, operador } = req.body || {};
    const dataFecha = data || diaHoje();

    // Calcular saldo real do banco
    const totais = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN tipo='saida'   THEN valor ELSE 0 END), 0) AS saldo
       FROM caixa_lancamentos WHERE data = $1`,
      [dataFecha]
    );

    const saldoFinal = Number(totais.rows[0]?.saldo || saldo || 0);

    await client.query(
      `INSERT INTO caixa_registros (data, saldo_final, operador, status, fechado_em)
       VALUES ($1, $2, $3, 'fechado', NOW())
       ON CONFLICT (data)
       DO UPDATE SET
         saldo_final = EXCLUDED.saldo_final,
         status      = 'fechado',
         fechado_em  = NOW()`,
      [dataFecha, saldoFinal, operador || '']
    );

    return res.status(200).json({ ok: true, saldo_final: saldoFinal });

  } catch (err) {
    console.error('Erro ao fechar caixa:', err);
    return res.status(500).json({ error: 'Erro interno.', details: err.message });
  } finally {
    client.release();
  }
}

// ── Rota: status do caixa ─────────────────────────────────────
async function rotaStatus(req, res) {
  const client = await pool.connect();
  try {
    await inicializar(client);
    const data = req.query?.data || diaHoje();

    const reg = await client.query(
      `SELECT * FROM caixa_registros WHERE data = $1`, [data]
    );

    return res.status(200).json(reg.rows[0] || { status: 'nao_aberto', data });
  } catch (err) {
    return res.status(500).json({ error: 'Erro interno.' });
  } finally {
    client.release();
  }
}
