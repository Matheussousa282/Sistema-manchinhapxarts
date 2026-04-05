// ================================================================
//  api/configuracoes.js
//
//  Rotas:
//    GET    /api/configuracoes?chave=formas_pagamento  → lista itens
//    GET    /api/configuracoes?chave=bandeiras         → lista itens
//    GET    /api/configuracoes                         → retorna tudo
//    POST   /api/configuracoes  { chave, item }        → adiciona item
//    DELETE /api/configuracoes?chave=X&item=Y          → remove item
//
//  Requer sessão válida (cookie mpx_session).
//  Apenas ADMIN pode adicionar ou remover; vendedores só leem.
// ================================================================

import pkg from 'pg';
import { parse } from 'cookie';

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const CHAVES_VALIDAS = ['formas_pagamento', 'bandeiras'];

// ── Helper de sessão ─────────────────────────────────────────
function getSession(req) {
  const cookies = parse(req.headers?.cookie || '');
  const raw = cookies['mpx_session'];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ── Garante que a tabela e os registros padrão existem ───────
async function garantirTabela(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      id            SERIAL PRIMARY KEY,
      chave         VARCHAR(100) UNIQUE NOT NULL,
      valor         JSONB        NOT NULL DEFAULT '[]',
      atualizado_em TIMESTAMP    DEFAULT NOW()
    )
  `);

  for (const chave of CHAVES_VALIDAS) {
    await client.query(
      `INSERT INTO configuracoes (chave, valor)
       VALUES ($1, '[]')
       ON CONFLICT (chave) DO NOTHING`,
      [chave]
    );
  }
}

// ── Handler principal ────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // Verifica sessão
  const session = getSession(req);
  if (!session || !session.userId) {
    return res.status(401).json({ error: 'Não autenticado. Faça login novamente.' });
  }

  const client = await pool.connect();

  try {
    await garantirTabela(client);

    // ── GET /api/configuracoes?chave=X ──────────────────────
    if (req.method === 'GET') {
      const { chave } = req.query;

      if (!chave) {
        const result = await client.query(
          `SELECT chave, valor FROM configuracoes ORDER BY chave`
        );
        const todas = {};
        result.rows.forEach(r => { todas[r.chave] = r.valor; });
        return res.status(200).json(todas);
      }

      if (!CHAVES_VALIDAS.includes(chave)) {
        return res.status(400).json({ error: 'Chave inválida.' });
      }

      const result = await client.query(
        `SELECT valor FROM configuracoes WHERE chave = $1`, [chave]
      );
      return res.status(200).json(result.rows[0]?.valor ?? []);
    }

    // ── POST /api/configuracoes  { chave, item } ────────────
    if (req.method === 'POST') {
      if (session.nivel !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem alterar configurações.' });
      }

      const { chave, item } = req.body || {};

      if (!chave || !CHAVES_VALIDAS.includes(chave)) {
        return res.status(400).json({ error: 'Chave inválida.' });
      }
      if (!item || typeof item !== 'string' || !item.trim()) {
        return res.status(400).json({ error: 'Item inválido.' });
      }

      const novoItem = item.trim();

      const atual = await client.query(
        `SELECT valor FROM configuracoes WHERE chave = $1`, [chave]
      );
      const lista = atual.rows[0]?.valor ?? [];

      if (lista.includes(novoItem)) {
        return res.status(409).json({ error: 'Item já cadastrado.' });
      }

      lista.push(novoItem);

      await client.query(
        `UPDATE configuracoes
         SET valor = $1, atualizado_em = NOW()
         WHERE chave = $2`,
        [JSON.stringify(lista), chave]
      );

      return res.status(201).json({ message: 'Item adicionado com sucesso!', lista });
    }

    // ── DELETE /api/configuracoes?chave=X&item=Y ────────────
    if (req.method === 'DELETE') {
      if (session.nivel !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradores podem alterar configurações.' });
      }

      const { chave, item } = req.query;

      if (!chave || !CHAVES_VALIDAS.includes(chave)) {
        return res.status(400).json({ error: 'Chave inválida.' });
      }
      if (!item) {
        return res.status(400).json({ error: 'Item obrigatório.' });
      }

      const atual = await client.query(
        `SELECT valor FROM configuracoes WHERE chave = $1`, [chave]
      );
      let lista = atual.rows[0]?.valor ?? [];
      lista = lista.filter(i => i !== item);

      await client.query(
        `UPDATE configuracoes
         SET valor = $1, atualizado_em = NOW()
         WHERE chave = $2`,
        [JSON.stringify(lista), chave]
      );

      return res.status(200).json({ message: 'Item removido com sucesso!', lista });
    }

    return res.status(405).json({ error: 'Método não permitido.' });

  } catch (err) {
    console.error('Erro em /api/configuracoes:', err);
    return res.status(500).json({ error: 'Erro interno do servidor.', details: err.message });
  } finally {
    client.release();
  }
}
