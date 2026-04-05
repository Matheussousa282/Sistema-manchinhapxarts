// ================================================================
//  api/vendedores.js
//
//  Vendedores:
//    GET    /api/vendedores            → lista ativos
//    POST   /api/vendedores            → cadastrar  [admin]
//    PUT    /api/vendedores            → ativar/desativar [admin]
//    DELETE /api/vendedores?id=X       → remover    [admin]
//
//  Metas:
//    GET    /api/vendedores?metas=1&mes=M&ano=A   → metas do mês
//    POST   /api/vendedores?metas=1               → salvar meta [admin]
//    GET    /api/vendedores?ranking=1&mes=M&ano=A → ranking com progresso
// ================================================================

import pkg from 'pg';
import { parse } from 'cookie';

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function getSession(req) {
  const cookies = parse(req.headers?.cookie || '');
  const raw = cookies['mpx_session'];
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { return null; }
}

async function garantirTabelas(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS vendedores (
      id        SERIAL PRIMARY KEY,
      nome      VARCHAR(100) UNIQUE NOT NULL,
      ativo     BOOLEAN      DEFAULT true,
      criado_em TIMESTAMP    DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS metas (
      id         SERIAL PRIMARY KEY,
      vendedor   VARCHAR(100) NOT NULL,
      mes        INTEGER      NOT NULL CHECK (mes BETWEEN 1 AND 12),
      ano        INTEGER      NOT NULL,
      valor_meta NUMERIC(10,2) NOT NULL DEFAULT 0,
      criado_em  TIMESTAMP    DEFAULT NOW(),
      UNIQUE (vendedor, mes, ano)
    )
  `);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const session = getSession(req);
  if (!session || !session.userId) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  const client = await pool.connect();

  try {
    await garantirTabelas(client);

    const { metas, ranking, mes, ano, id } = req.query;
    const mesN = parseInt(mes) || new Date().getMonth() + 1;
    const anoN = parseInt(ano) || new Date().getFullYear();

    // ── GET /api/vendedores?ranking=1 — progresso vs meta ──
    if (req.method === 'GET' && ranking) {
      // Soma vendas por vendedor no mês/ano
      const vendasRes = await client.query(`
        SELECT
          vendedor,
          COUNT(*)::int            AS qtd_pedidos,
          SUM(valor_total)         AS total_vendas,
          SUM(valor_recebido)      AS total_recebido
        FROM pedidos
        WHERE EXTRACT(MONTH FROM data_pedido) = $1
          AND EXTRACT(YEAR  FROM data_pedido) = $2
          AND status != 'Cancelado'
        GROUP BY vendedor
      `, [mesN, anoN]);

      // Busca metas do mês
      const metasRes = await client.query(`
        SELECT vendedor, valor_meta FROM metas
        WHERE mes = $1 AND ano = $2
      `, [mesN, anoN]);

      const metaMap = {};
      metasRes.rows.forEach(m => { metaMap[m.vendedor] = Number(m.valor_meta); });

      // Lista todos os vendedores ativos
      const vendRes = await client.query(
        `SELECT nome FROM vendedores WHERE ativo = true ORDER BY nome`
      );

      const resultado = vendRes.rows.map(v => {
        const venda = vendasRes.rows.find(x => x.vendedor === v.nome) || {};
        const meta  = metaMap[v.nome] || 0;
        const total = Number(venda.total_vendas || 0);
        const pct   = meta > 0 ? Math.min(100, (total / meta) * 100) : 0;
        return {
          vendedor    : v.nome,
          qtd_pedidos : venda.qtd_pedidos || 0,
          total_vendas: total,
          meta        : meta,
          percentual  : Math.round(pct * 10) / 10,
          falta       : Math.max(0, meta - total),
        };
      });

      return res.status(200).json(resultado);
    }

    // ── GET /api/vendedores?metas=1 — lista metas do mês ───
    if (req.method === 'GET' && metas) {
      const result = await client.query(`
        SELECT * FROM metas WHERE mes = $1 AND ano = $2 ORDER BY vendedor
      `, [mesN, anoN]);
      return res.status(200).json(result.rows);
    }

    // ── GET /api/vendedores — lista vendedores ativos ───────
    if (req.method === 'GET') {
      const result = await client.query(
        `SELECT * FROM vendedores ORDER BY ativo DESC, nome ASC`
      );
      return res.status(200).json(result.rows);
    }

    // ── POST /api/vendedores?metas=1 — salvar meta ──────────
    if (req.method === 'POST' && metas) {
      if (session.nivel !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem definir metas.' });
      }
      const { vendedor, valor_meta, mes: m, ano: a } = req.body || {};
      if (!vendedor || valor_meta === undefined) {
        return res.status(400).json({ error: 'vendedor e valor_meta são obrigatórios.' });
      }
      await client.query(`
        INSERT INTO metas (vendedor, mes, ano, valor_meta)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (vendedor, mes, ano)
        DO UPDATE SET valor_meta = EXCLUDED.valor_meta
      `, [vendedor, parseInt(m) || mesN, parseInt(a) || anoN, valor_meta]);

      return res.status(201).json({ message: 'Meta salva com sucesso!' });
    }

    // ── POST /api/vendedores — cadastrar vendedor ────────────
    if (req.method === 'POST') {
      if (session.nivel !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem cadastrar vendedores.' });
      }
      const { nome } = req.body || {};
      if (!nome || !nome.trim()) {
        return res.status(400).json({ error: 'Nome obrigatório.' });
      }
      const existe = await client.query(
        `SELECT id FROM vendedores WHERE nome = $1`, [nome.trim()]
      );
      if (existe.rows.length) {
        return res.status(409).json({ error: 'Vendedor já cadastrado.' });
      }
      await client.query(
        `INSERT INTO vendedores (nome) VALUES ($1)`, [nome.trim()]
      );
      return res.status(201).json({ message: 'Vendedor cadastrado com sucesso!' });
    }

    // ── PUT /api/vendedores — ativar/desativar ───────────────
    if (req.method === 'PUT') {
      if (session.nivel !== 'admin') {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      const { id: uid, ativo } = req.body || {};
      if (!uid) return res.status(400).json({ error: 'ID obrigatório.' });
      await client.query(`UPDATE vendedores SET ativo = $1 WHERE id = $2`, [ativo, uid]);
      return res.status(200).json({ message: 'Atualizado!' });
    }

    // ── DELETE /api/vendedores?id=X ─────────────────────────
    if (req.method === 'DELETE') {
      if (session.nivel !== 'admin') {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      if (!id) return res.status(400).json({ error: 'ID obrigatório.' });
      await client.query(`DELETE FROM vendedores WHERE id = $1`, [id]);
      return res.status(200).json({ message: 'Vendedor removido!' });
    }

    return res.status(405).json({ error: 'Método não permitido.' });

  } catch (err) {
    console.error('Erro em /api/vendedores:', err);
    return res.status(500).json({ error: 'Erro interno.', details: err.message });
  } finally {
    client.release();
  }
}
