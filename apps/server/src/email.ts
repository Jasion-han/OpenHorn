import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export async function sendEmail({
  to,
  subject,
  text,
  html,
}: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}) {
  if (!resend) {
    console.warn("[email] RESEND_API_KEY not configured, email not sent:", { to, subject });
    return;
  }
  const from = process.env.EMAIL_FROM || "OpenHorn <noreply@openhorn.dev>";
  await resend.emails.send({ from, to, subject, text, html });
}
