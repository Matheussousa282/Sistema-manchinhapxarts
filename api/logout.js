// ================================================================
//  api/logout.js
//  POST /api/logout — apaga o cookie de sessão
// ================================================================

import { serialize } from 'cookie';

const COOKIE_NAME = 'mpx_session';

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  res.setHeader('Set-Cookie', serialize(COOKIE_NAME, '', {
    httpOnly : true,
    sameSite : 'lax',
    path     : '/',
    maxAge   : 0,
  }));

  return res.status(200).json({ ok: true });
}
