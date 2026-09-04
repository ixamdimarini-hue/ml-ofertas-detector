export default async function handler(req, res) {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).json({
      ok: false,
      error,
      error_description: error_description || null
    });
  }

  if (!code) {
    return res.status(200).json({
      ok: true,
      message: "Callback de Mercado Libre activo. Todavía no se recibió un código OAuth."
    });
  }

  // En el siguiente paso intercambiaremos este 'code'
  // por access_token + refresh_token usando variables de entorno seguras.
  return res.status(200).json({
    ok: true,
    message: "Código OAuth recibido correctamente.",
    next: "Intercambiar el código por tokens en el backend."
  });
}
