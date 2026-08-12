/**
 * Mailbox email relay.
 *
 * Supabase posts here when a digest is due, and this sends the email from the
 * Gmail account that owns the script. Nothing else about the app touches Gmail.
 *
 * Setup
 *   1. script.google.com > New project. Paste this file in, replacing anything
 *      already there. Name the project "Mailbox relay".
 *   2. In the app: To do > Email notifications > Generate a secret. Copy it and
 *      paste it between the quotes on the SHARED_SECRET line just below.
 *      Then save this file (the disk icon, or cmd S).
 *   3. Deploy > New deployment. Click the gear next to "Select type" and pick
 *      Web app.
 *        Execute as:        Me
 *        Who has access:    Anyone
 *      Deploy, approve the permission prompt, and copy the Web app URL. It
 *      looks like https://script.google.com/macros/s/AKfy..../exec
 *   4. Paste that URL and the same secret into the app, then Save, then tap
 *      "Send me a test email now".
 *
 * "Anyone" only means anyone who knows the URL can POST to it. The secret check
 * below is what stops a stranger with the URL from sending mail through it.
 */

var SHARED_SECRET = 'PASTE_THE_SECRET_HERE';

function doPost(e) {
  try {
    // A script property of the same name wins if one is set, but the constant
    // above is enough on its own.
    var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET') || SHARED_SECRET;
    if (!expected || expected === 'PASTE_THE_SECRET_HERE') {
      return reply(500, 'SHARED_SECRET has not been filled in at the top of Code.gs');
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
