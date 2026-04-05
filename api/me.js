// ================================================================
//  api/me.js
//  GET /api/me — verifica sessão atual pelo cookie
// ================================================================

import { parse } from 'cookie';

const COOKIE_NAME = 'mpx_session';

function getSession(req) {
  const cookies = parse(req.headers?.cookie || '');
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { return null; }
}

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const session = getSession(req);

  if (!session || !session.userId) {
    return res.status(401).json({ ok: false, error: 'Não autenticado.' });
  }

  return res.status(200).json({
    ok     : true,
    usuario: session.usuario,
    nivel  : session.nivel,
  });
}
