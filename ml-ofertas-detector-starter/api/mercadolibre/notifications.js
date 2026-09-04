export default async function handler(req, res) {
  // Mercado Libre necesita una URL pública que acepte notificaciones.
  // Por ahora confirmamos recepción con HTTP 200.
  if (req.method === "POST") {
    console.log("Notificación Mercado Libre:", req.body);
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({
    ok: true,
    message: "Endpoint de notificaciones activo."
  });
}
