import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function calcularTotal(itens) {
  if (!itens || !Array.isArray(itens)) return 0;
  return itens.reduce((acc, i) => acc + (parseFloat(i.quantidade) || 0) * (parseFloat(i.valorUnit) || 0), 0);
}

function formatarDataDB(dataStr) {
  if (!dataStr) return null;
  const data = new Date(dataStr);
  if (isNaN(data)) return null;
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function dataAtualFormatada() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'America/Fortaleza'
  });
  const [{ value: dia }, , { value: mes }, , { value: ano }] = formatter.formatToParts(now);
  return `${ano}-${mes}-${dia}`;
}

export default async function handler(req, res) {
  const client = await pool.connect();

  try {
    // ── GET ──────────────────────────────────────────────────
    if (req.method === 'GET') {
      const result = await client.query('SELECT * FROM pedidos ORDER BY id DESC');
      return res.status(200).json(result.rows);
    }

    // ── POST ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const {
        nomeCliente, telefoneCliente, vendedor, itens,
        valorRecebido, dataEntrega, status, anotacoes,
        tipoPedido,   // ✅ campo presencial/online
        desconto,     // ✅ valor do desconto
      } = req.body;

      const total = calcularTotal(itens);

      await client.query(
        `INSERT INTO pedidos
          (vendedor, nome_cliente, telefone_cliente, itens, valor_total, valor_recebido,
           data_pedido, data_entrega, status, anotacoes, tipo_pedido, desconto)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          vendedor,
          nomeCliente,
          telefoneCliente,
          JSON.stringify(itens),
          total,
          valorRecebido || 0,
          dataAtualFormatada(),
          formatarDataDB(dataEntrega),
          status || 'Aguardando Retorno',
          anotacoes || '',
          tipoPedido || '',   // ✅ salva 'presencial' ou 'online'
          desconto   || 0,    // ✅ salva o desconto
        ]
      );

      return res.status(201).json({ message: 'Pedido criado com sucesso!' });
    }

    // ── PUT ──────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const {
        id, valorRecebido, status, vendedor,
        telefoneCliente, itens, anotacoes,
        tipoPedido,  // ✅ permite atualizar tipo também
      } = req.body;

      if (itens && Array.isArray(itens)) {
        const total = calcularTotal(itens);
        await client.query(
          `UPDATE pedidos SET itens = $1, valor_total = $2, anotacoes = $3 WHERE id = $4`,
          [JSON.stringify(itens), total, anotacoes || '', id]
        );
      }

      await client.query(
        `UPDATE pedidos
         SET valor_recebido = $1, status = $2, vendedor = $3,
             telefone_cliente = $4, anotacoes = $5,
             tipo_pedido = COALESCE(NULLIF($6,''), tipo_pedido)
         WHERE id = $7`,
        [
          valorRecebido || 0,
          status,
          vendedor,
          telefoneCliente,
          anotacoes || '',
          tipoPedido || '',  // ✅ só sobrescreve se vier preenchido
          id,
        ]
      );

      return res.status(200).json({ message: 'Pedido atualizado com sucesso!' });
    }

    // ── DELETE ───────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { id } = req.query;
      await client.query(`DELETE FROM pedidos WHERE id = $1`, [id]);
      return res.status(200).json({ message: 'Pedido removido com sucesso!' });
    }

    return res.status(405).json({ error: 'Método não permitido' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  } finally {
    client.release();
  }
}
