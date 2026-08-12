/**
 * Mailbox email relay.
 *
 * Supabase posts here when a digest is due, and this sends the email from the
 * Gmail account that owns the script. Nothing else about the app touches Gmail.
 *
 * Setup
 *   1. script.google.com > New project. Paste this file in, replacing anything
 *      already there. Name the project "Mailbox relay".
 *   2. Project Settings > Script Properties > Add script property:
 *        SHARED_SECRET = the secret Claude gives you (or any long random string)
 *   3. Deploy > New deployment > type Web app.
 *        Execute as:        Me
 *        Who has access:    Anyone
 *      Deploy, approve the permission prompt, and copy the Web app URL. It
 *      looks like https://script.google.com/macros/s/AKfy..../exec
 *   4. Paste that URL into the app under Notifications.
 *
 * "Anyone" only means anyone who knows the URL can POST to it. The secret check
 * below is what stops a stranger with the URL from sending mail through it.
 */

function doPost(e) {
  try {
    var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!expected) {
      return reply(500, 'SHARED_SECRET script property is not set');
    }

    var payload = JSON.parse(e.postData.contents);

    if (payload.secret !== expected) {
      return reply(403, 'bad secret');
    }
    if (!payload.to || !payload.subject) {
      return reply(400, 'missing to or subject');
    }

    MailApp.sendEmail({
      to: payload.to,
      subject: payload.subject,
      body: (payload.body || '') + '\n\n--\nMailbox\nhttps://mustafaalbaree-uky.github.io/mailbox/\n',
      name: 'Mailbox'
    });

    return reply(200, 'sent');
  } catch (err) {
    return reply(500, String(err));
  }
}

// A plain GET is handy for checking the deployment is live in a browser.
function doGet() {
  return reply(200, 'Mailbox relay is running. Send a POST to deliver mail.');
}

function reply(code, message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: code, message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this once from the editor to check Gmail sending works and to trigger the
 * permission prompt before the first real digest arrives. Change the address.
 */
function testSend() {
  MailApp.sendEmail({
    to: 'REPLACE_WITH_YOUR_EMAIL',
    subject: 'Mailbox: relay test',
    body: 'The relay can send mail.',
    name: 'Mailbox'
  });
}
