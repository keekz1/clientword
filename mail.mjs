// Email: a console transport for development (messages are kept in `outbox`) and Amazon SES for production.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeHeader = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, 200); // block header injection

export function createMailer(config) {
  const outbox = [];
  let sesSend = null;
  return {
    outbox,
    async send({ to, subject, text, html }) {
      const msg = { to: safeHeader(to), subject: safeHeader(subject), text, html, from: config.mailFrom };
      if (config.mailKind === "ses") {
        if (!sesSend) {
          const ses = await import("@aws-sdk/client-sesv2");
          const client = new ses.SESv2Client({ region: config.region });
          sesSend = (m) => client.send(new ses.SendEmailCommand({
            FromEmailAddress: m.from, Destination: { ToAddresses: [m.to] },
            Content: { Simple: { Subject: { Data: m.subject, Charset: "UTF-8" }, Body: { Text: { Data: m.text, Charset: "UTF-8" }, Html: { Data: m.html, Charset: "UTF-8" } } } },
          }));
        }
        await sesSend(msg);
      } else {
        outbox.push(msg);
        if (outbox.length > 200) outbox.shift();
        if (!config.production && !process.env.QUIET) console.log(`[mail] to ${msg.to}: ${msg.subject}`);
      }
    },
  };
}

// One shared layout so every email looks consistent. `colour` is the freelancer's brand colour.
function layout({ business, colour = "#4f46e5", heading, paragraphs, button, footer }) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.55">${esc(p)}</p>`).join("");
  const btn = button ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="background:${esc(colour)};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>` : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#14161f"><div style="max-width:520px;margin:0 auto;padding:24px 16px"><div style="font-weight:700;margin-bottom:12px">${esc(business)}</div><div style="background:#fff;border:1px solid #e4e7ee;border-radius:12px;padding:24px"><h1 style="font-size:20px;margin:0 0 14px">${esc(heading)}</h1>${body}${btn}</div><p style="color:#667085;font-size:12px;margin:14px 4px">${esc(footer || "")}</p></div></body></html>`;
  const text = [heading, "", ...paragraphs, button ? `\n${button.label}: ${button.url}` : "", footer ? `\n${footer}` : ""].join("\n");
  return { html, text };
}

export const emails = {
  invite: ({ f, c, link }) => ({
    subject: `${f.business}: your onboarding page`,
    ...layout({ business: f.business, colour: f.colour, heading: `Welcome, ${c.name.split(" ")[0]}`,
      paragraphs: [f.welcome || `${f.name} has set up a short onboarding page for you.`, "It only takes a few minutes: tell us about your project, share any files and book a call."],
      button: { label: "Open your page", url: link }, footer: `Sent by ${f.business} on behalf of ${f.name}. This link is private to you.` }),
  }),
  reminder: ({ f, c, link }) => ({
    subject: `Reminder: finish your onboarding with ${f.business}`,
    ...layout({ business: f.business, colour: f.colour, heading: `A quick reminder, ${c.name.split(" ")[0]}`,
      paragraphs: [`${f.name} is waiting on a few last steps before getting started.`, "It takes just a couple of minutes."],
      button: { label: "Continue", url: link }, footer: `Sent by ${f.business} on behalf of ${f.name}.` }),
  }),
  finished: ({ f, c, link }) => ({
    subject: `${c.name} has finished onboarding`,
    ...layout({ business: "Clientword", heading: `${c.name} is ready`,
      paragraphs: [`${c.name} has completed every step${c.project ? ` for "${c.project}"` : ""}.`, "Their answers, files and booking are waiting for you."],
      button: { label: "Open client", url: link }, footer: "You can turn these emails off in Setup." }),
  }),
  signed: ({ f, c, link }) => ({
    subject: `${c.name} signed "${c.contract?.title || "your contract"}"`,
    ...layout({ business: "Clientword", heading: "Contract signed",
      paragraphs: [`${c.name} signed "${c.contract?.title}" by typing their name.`, "The signature record is saved on their page."],
      button: { label: "View record", url: link }, footer: "You can turn these emails off in Setup." }),
  }),
  messageToFreelancer: ({ f, c, link, text }) => ({
    subject: `New message from ${c.name}`,
    ...layout({ business: "Clientword", heading: `${c.name} sent you a message`,
      paragraphs: [text.length > 400 ? text.slice(0, 400) + "…" : text], button: { label: "Reply", url: link }, footer: "You can turn these emails off in Setup." }),
  }),
  messageToClient: ({ f, c, link, text }) => ({
    subject: `New message from ${f.name}`,
    ...layout({ business: f.business, colour: f.colour, heading: `${f.name} sent you a message`,
      paragraphs: [text.length > 400 ? text.slice(0, 400) + "…" : text], button: { label: "Open your page", url: link }, footer: `Sent by ${f.business}.` }),
  }),
  reset: ({ f, link }) => ({
    subject: "Reset your Clientword password",
    ...layout({ business: "Clientword", heading: "Reset your password",
      paragraphs: ["Use the button below to choose a new password. The link works once and expires in one hour.", "If you didn't ask for this, you can ignore this email; your password hasn't changed."],
      button: { label: "Choose a new password", url: link }, footer: "" }),
  }),
};
