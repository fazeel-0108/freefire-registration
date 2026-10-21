/* ==================================================================
   Approve → save → WhatsApp: checks that run without a browser.

   The functions are extracted from the real admin.js (between two
   markers) and executed in a vm, so this tests the shipped source and
   not a copy of it. The parts that need a DOM (the click handler, the
   network call, the tab) are exercised in the browser against
   .preview-server.js instead; what is proven here is the part that is
   easiest to get subtly wrong: number normalisation, the message text
   and the payment line.

     node verify-approve.js
   ================================================================== */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = path.join(__dirname, "admin.js");
const source = fs.readFileSync(file, "utf8");

const START = "/* ------------------- WhatsApp number + click-to-chat";
const END = "/* ------------------------------ sign in";

const from = source.indexOf(START);
const to = source.indexOf(END);

if (from === -1 || to === -1 || to <= from) {
  console.error("Could not find the helper block in admin.js — the test needs updating.");
  process.exit(1);
}

/* paymentStatusLine formats the fee it was given, and formatMoney lives above
   the extracted block. Pull the real one in rather than a stub, so the test
   still exercises the shipped formatter. */
const moneyFrom = source.indexOf("function formatMoney(value) {");
const moneyTo = moneyFrom === -1 ? -1 : source.indexOf("\n}", moneyFrom) + 2;
if (moneyFrom === -1 || moneyTo <= moneyFrom) {
  console.error("Could not find formatMoney in admin.js - the test needs updating.");
  process.exit(1);
}
const prelude = source.slice(moneyFrom, moneyTo);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  prelude +
    "\n" +
    source.slice(from, to) +
    "\nthis.__approve = { waNumber, waUrl, whatsappLink, waRecipients, paymentStatusLine, approvalMessage };",
  sandbox
);

const { waNumber, waUrl, whatsappLink, waRecipients, paymentStatusLine, approvalMessage } = sandbox.__approve;

let pass = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    pass++;
  } else {
    failures.push(label + (detail ? " — " + detail : ""));
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, "got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
}

/* ---------------------------- numbers ---------------------------- */

eq("plain 10-digit number gets 91", waNumber("9876543210"), "919876543210");
eq("spaced number is normalised", waNumber("98765 43210"), "919876543210");
eq("+91 prefix is kept once", waNumber("+91 98765 43210"), "919876543210");
eq("already-91 number is left alone", waNumber("919876543210"), "919876543210");
eq("leading zero is dropped", waNumber("09876543210"), "919876543210");
eq("a 9-digit number is refused", waNumber("987654321"), "");
eq("a number starting 5 is refused", waNumber("5876543210"), "");
eq("an 11-digit number starting 9 is refused", waNumber("9198765432100"), "");
eq("letters are refused", waNumber("not a number"), "");
eq("empty is refused", waNumber(""), "");
eq("null is refused", waNumber(null), "");
eq("undefined is refused", waNumber(undefined), "");

/* ----------------------------- links ----------------------------- */

eq(
  "link carries the encoded message",
  waUrl("9876543210", "hello *Team* 🔥 & more"),
  "https://wa.me/919876543210?text=" + encodeURIComponent("hello *Team* 🔥 & more")
);
check(
  "the message is URL-encoded, never raw",
  waUrl("9876543210", "a b&c=d\nline").indexOf(" ") === -1 &&
    waUrl("9876543210", "a b&c=d\nline").indexOf("\n") === -1,
  waUrl("9876543210", "a b&c=d\nline")
);
eq("no message means no query string", waUrl("9876543210", ""), "https://wa.me/919876543210");
eq("an unusable number produces no link", waUrl("12345", "hi"), "");
eq("the roster helper uses the same rule", whatsappLink("9876543210"), "https://wa.me/919876543210");
eq("the roster helper refuses junk", whatsappLink("12345"), "");

/* --------------------------- recipients --------------------------- */

const record = {
  id: "AbCdEfGhIjKlMnOpQrSt",
  teamName: "Night Ravens",
  department: "Civil Engineering",
  players: [
    { name: "Asha", whatsapp: "9876543210" },
    { name: "Vikram", whatsapp: "98765 43211" },
    { name: "Imran", whatsapp: "" }
  ],
  payment: { status: "PENDING", method: "CASH", entryFee: 100 }
};

const people = waRecipients(record);
eq("every player is a candidate", people.length, 3);
eq("the first player column is the leader", people[0].label, "Team leader");
eq("the leader keeps their number", people[0].number, "919876543210");
eq("player 2 is normalised too", people[1].number, "919876543211");
eq("a missing number stays missing", people[2].number, "");
eq("a missing number is not invented", people[2].raw, "");

const headless = waRecipients({ teamName: "Empty", players: [] });
eq("a roster with no players has no recipients", headless.length, 0);

/* -------------------------- payment line -------------------------- */

check("paid is stated plainly", /Paid/.test(paymentStatusLine({ status: "PAID" })));
check("a pending cash payment is never called paid", !/Paid/.test(paymentStatusLine({ status: "PENDING" })));
check("pending says the fee is due", /still due/.test(paymentStatusLine({ status: "PENDING" })));
check("pending verification is described as being checked",
  /being checked/.test(paymentStatusLine({ status: "PENDING VERIFICATION" })));
check("needs review is not a paid claim",
  !/Paid/.test(paymentStatusLine({ status: "NEEDS REVIEW" })));
check("an unset payment asks for a choice", /Not selected/.test(paymentStatusLine(undefined)));
check("every unpaid line names the fee recorded on the row",
  ["PENDING", "PENDING VERIFICATION", "NEEDS REVIEW", "REJECTED", "NOT SELECTED"]
    .every((status) => paymentStatusLine({ status, entryFee: 150 }).indexOf("₹150") !== -1));
// The fee is read from the row, so a team that registered before a price change
// is quoted its own fee and not today's.
check("the payment line follows the row's fee, not a constant",
  paymentStatusLine({ status: "PENDING", entryFee: 150 }).indexOf("₹100") === -1);
check("a paid team is not asked for money again",
  paymentStatusLine({ status: "PAID", entryFee: 100 }).indexOf("₹100") === -1);

/* ---------------------------- message ---------------------------- */

const message = approvalMessage(record, "Asha");

check("greets the recipient by name", message.indexOf("Hello Asha!") === 0, message.split("\n")[0]);
check("names the team in bold", message.indexOf("Your team *Night Ravens* has been APPROVED") !== -1);
check("gives the department", message.indexOf("🏫 Department: Civil Engineering") !== -1);
check("gives the registration id", message.indexOf("🆔 Registration ID: AbCdEfGhIjKlMnOpQrSt") !== -1);
check("states the payment status", message.indexOf("💰 Payment status: Pending") !== -1);
check("does not claim payment was confirmed", !/payment (has been )?(confirmed|received)/i.test(message));
check("ends with the organising team", message.trim().endsWith("— QQSGP Free Fire Tournament Organizing Team"));
check("keeps the emoji the organiser asked for", message.indexOf("🎉") !== -1 && message.indexOf("🔥") !== -1);
check("has no unresolved placeholders", !/{{|\}\}/.test(message));
check("every line is filled in", message.split("\n").every((line) => line.indexOf("undefined") === -1 && line.indexOf("null") === -1));

const paidRecord = Object.assign({}, record, { payment: { status: "PAID", method: "ONLINE" } });
check("a paid team is told so", /Payment status: Paid/.test(approvalMessage(paidRecord, "Asha")));

const nameless = approvalMessage({ id: "x", teamName: "Solo", players: [] }, "");
check("a missing recipient name still produces a sentence", /^Hello team!/.test(nameless));
check("a missing department is labelled, not invented", /Department: Not recorded/.test(nameless));

/* ------------- the click path really is wired to Approve ------------- */

check(
  "the Approve button routes into the WhatsApp flow",
  /if \(nextStatus === "APPROVED"\) \{\s*\n\s*approveTeam\(record\);/.test(source)
);
check(
  "the tab is reserved before the save is awaited",
  /tab = window\.open\("", "_blank"\)[\s\S]{0,2500}await api\("status"/.test(source)
);
check(
  "the tab is closed when the save fails",
  /if \(!result\.ok\) \{[\s\S]{0,120}tab\.close\(\)/.test(source)
);
check(
  "the message is built from the server's record, not the stale copy",
  /const saved = result\.record;[\s\S]{0,400}approvalMessage\(saved, recipient\.name\)/.test(source)
);
check(
  "an already-approved team is not approved again",
  /record\.status === "APPROVED"[\s\S]{0,120}Nothing was saved again/.test(source)
);
check(
  "a double tap cannot start two approvals",
  /if \(state\.approving\) return;/.test(source)
);
check(
  "an unusable leader number asks instead of guessing",
  /if \(leader && leader\.number\) \{[\s\S]{0,200}if \(usable\.length\) \{[\s\S]{0,60}pickRecipient\(record, usable\)/.test(source)
);

/* ----------------------------- report ----------------------------- */

if (failures.length) {
  console.error("\nFAILED " + failures.length + " of " + (pass + failures.length) + " checks:\n");
  failures.forEach((label) => console.error("  ✗ " + label));
  process.exit(1);
}

console.log("verify-approve.js: " + pass + " checks passed.");
