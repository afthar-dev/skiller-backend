/**
 * The three pages of the unsubscribe link, self-contained (inline style, no script, no external request) and free of any member data: they say what
 * the link is for and nothing about who holds it. The confirmation form has no `action`, so it posts back to the very signed link that was opened.
 */
const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f6f8;color:#1c1c22}
main{max-width:30rem;margin:12vh auto 0;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{line-height:1.5;margin:.5rem 0}
button{margin-top:1rem;padding:.7rem 1.4rem;font-size:1rem;border:0;border-radius:8px;background:#4f46e5;color:#fff;cursor:pointer}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;

export const confirmPage = () =>
  layout(
    "Unsubscribe from promotional email",
    `<h1>Unsubscribe from promotional email</h1>
<p>Press the button to stop promotional emails from Skiller. Emails about your account, sign-in codes and receipts will still reach you.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`,
  );

export const donePage = () =>
  layout(
    "You are unsubscribed",
    `<h1>You are unsubscribed</h1>
<p>You will not get promotional emails from Skiller any more. Emails about your account, sign-in codes and receipts will still reach you.</p>
<p>You can turn promotional email back on in your notification settings.</p>`,
  );

export const invalidPage = () =>
  layout(
    "This link is not valid",
    `<h1>This unsubscribe link is not valid</h1>
<p>The link may be damaged or incomplete. Open it again from the original email, or change your email preferences in your Skiller notification settings.</p>`,
  );
