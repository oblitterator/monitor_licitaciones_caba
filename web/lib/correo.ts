import "server-only";

/**
 * Envío de mails de las alertas. TODAVÍA NO IMPLEMENTADO (fuera del alcance de esta versión).
 *
 * Interfaz prevista:
 * - enviarConfirmacion(): al crear una alerta, manda el enlace de doble opt-in
 *   `${SITE_URL}/alertas/confirmar?token=<token_confirmacion>`. Hasta que la persona
 *   no lo abre, `app.alerta.confirmada_en` queda en NULL y no se le manda nada.
 * - Cada resumen diario incluye `${SITE_URL}/alertas/baja?token=<token_baja>`.
 *
 * TODO: elegir proveedor (p. ej. Cloudflare Email Service, Amazon SES o Postmark),
 * agregar su clave como secreto (wrangler secret put ...) e implementar estas funciones.
 */
export type MailConfirmacion = { email: string; tipo: string; valor: string; urlConfirmar: string };

export async function enviarConfirmacion(_m: MailConfirmacion): Promise<{ enviado: boolean }> {
  void _m;
  return { enviado: false };
}
