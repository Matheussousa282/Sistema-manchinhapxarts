import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Cria tabela de usuários se não existir + usuário admin padrão
async function inicializarTabela(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id       SERIAL PRIMARY KEY,
      usuario  VARCHAR(100) UNIQUE NOT NULL,
      senha    VARCHAR(255) NOT NULL,
      nivel    VARCHAR(50)  NOT NULL DEFAULT 'vendedor',
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  // Garante que sempre existe um admin padrão
  const existe = await client.query(`SELECT id FROM usuarios WHERE usuario = 'admin'`);
  if (existe.rows.length === 0) {
    await client.query(
      `INSERT INTO usuarios (usuario, senha, nivel) VALUES ($1, $2, $3)`,
      ['admin', '9077', 'admin']
    );
  }
}

export default async function handler(req, res) {
  const client = await pool.connect();

  try {
    await inicializarTabela(client);

    // ── GET /api/usuarios — Lista todos
    if (req.method === 'GET' && !req.url.includes('/login')) {
      const result = await client.query(
        `SELECT id, usuario, nivel, criado_em FROM usuarios ORDER BY id ASC`
      );
      return res.status(200).json(result.rows);
    }

    // ── POST /api/usuarios/login — Autenticação
    if (req.method === 'POST' && req.url.includes('/login')) {
      const { usuario, senha } = req.body;
      if (!usuario || !senha) {
        return res.status(400).json({ error: 'Usuário e senha obrigatórios.' });
      }

      const result = await client.query(
        `SELECT id, usuario, nivel FROM usuarios WHERE usuario = $1 AND senha = $2`,
        [usuario, senha]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ ok: false, error: 'Usuário ou senha incorretos.' });
      }

      const user = result.rows[0];
      return res.status(200).json({ ok: true, usuario: user.usuario, nivel: user.nivel });
    }

    // ── POST /api/usuarios — Cadastrar novo usuário
    if (req.method === 'POST') {
      const { usuario, senha, nivel } = req.body;
      if (!usuario || !senha) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
      }

      // Verifica duplicata
      const existe = await client.query(
        `SELECT id FROM usuarios WHERE usuario = $1`, [usuario]
      );
      if (existe.rows.length > 0) {
        return res.status(409).json({ error: 'Este nome de usuário já existe.' });
      }

      await client.query(
        `INSERT INTO usuarios (usuario, senha, nivel) VALUES ($1, $2, $3)`,
        [usuario, senha, nivel || 'vendedor']
      );

      return res.status(201).json({ message: 'Usuário cadastrado com sucesso!' });
    }

    // ── PUT /api/usuarios — Alterar senha
    if (req.method === 'PUT') {
      const { id, senha } = req.body;
      if (!id || !senha) {
        return res.status(400).json({ error: 'ID e nova senha são obrigatórios.' });
      }

      await client.query(
        `UPDATE usuarios SET senha = $1 WHERE id = $2`,
        [senha, id]
      );

      return res.status(200).json({ message: 'Senha alterada com sucesso!' });
    }

    // ── DELETE /api/usuarios?id=X — Remover usuário
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'ID obrigatório.' });
      }

      // Não permite deletar o admin principal
      const user = await client.query(`SELECT usuario FROM usuarios WHERE id = $1`, [id]);
      if (user.rows.length > 0 && user.rows[0].usuario === 'admin') {
        return res.status(403).json({ error: 'Não é possível remover o usuário admin principal.' });
      }

      await client.query(`DELETE FROM usuarios WHERE id = $1`, [id]);
      return res.status(200).json({ message: 'Usuário removido com sucesso!' });
    }

    return res.status(405).json({ error: 'Método não permitido.' });

  } catch (err) {
    console.error('Erro na API de usuários:', err);
    return res.status(500).json({ error: 'Erro interno do servidor.', details: err.message });
  } finally {
    client.release();
  }
}
