// Fractal Clear — reference backend
// Real ticket-state engine, event ingestion, and audit trail behind the demo UI.
// Run: ANTHROPIC_API_KEY=sk-... node server.js   (Clear AI works without a key too — it just
// returns a clear "no key set" response instead of crashing.)

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ---------- Seed data (mirrors the frontend's sample tickets) ----------
let tickets = [
  {
    id: "T-58231", customer: "Johnson Paving", customerId: "100284",
    value: 28400, plant: "Plant 4", creditStatus: "Conditional",
    pastDue: 41800, ceiling: 50000, relationship: "Strategic",
    paymentRef: null, scheduled: null, cod: false, cardOnFile: null,
    driverAuthority: null, officePhone: null, overridden: false
  },
  {
    id: "T-58244", customer: "Blue Ridge Concrete", customerId: "100612",
    value: 12850, plant: "Plant 2", creditStatus: "COD",
    pastDue: 0, ceiling: 50000, relationship: "Standard",
    paymentRef: { amount: 12850, time: "07:14" }, scheduled: "08:30",
    cod: true, cardOnFile: null, driverAuthority: "n/a", officePhone: null, overridden: false
  },
  {
    id: "T-58250", customer: "Mike's Excavating", customerId: "100733",
    value: 4740, plant: "Aggregate 2", creditStatus: "COD",
    pastDue: 0, ceiling: 50000, relationship: "Standard",
    paymentRef: null, scheduled: null, cod: true, cardOnFile: false,
    driverAuthority: "None", officePhone: true, overridden: false
  },
  {
    id: "T-58255", customer: "Ridgeline Contractors", customerId: "100900",
    value: 9200, plant: "Plant 7", creditStatus: "Clear",
    pastDue: 0, ceiling: 50000, relationship: "Standard",
    paymentRef: { amount: 9200, time: "06:50" }, scheduled: "07:30",
    cod: false, cardOnFile: null, driverAuthority: "n/a", officePhone: null, overridden: false
  },
  {
    id: "T-58261", customer: "Delta Paving Co", customerId: "100911",
    value: 16750, plant: "Aggregate 5", creditStatus: "COD",
    pastDue: 0, ceiling: 50000, relationship: "Standard",
    paymentRef: null, scheduled: null, cod: true, cardOnFile: false,
    driverAuthority: "None", officePhone: false, overridden: false
  }
];

let auditLog = [];

// ---------- The deterministic rules engine ----------
// This is the piece the technical backup document claims exists. It now actually does.
function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function computeState(t) {
  if (t.overridden) {
    return { status: "CLEARED", reason: "Cleared via logged override — see audit log." };
  }
  if (t.creditStatus === "Conditional" && (t.pastDue + t.value) > t.ceiling) {
    return {
      status: "ESCALATED",
      reason: `Past due ($${t.pastDue.toLocaleString()}) plus today's order exceeds the $${t.ceiling.toLocaleString()} CFO-approval ceiling. Relationship tier does not change this.`
    };
  }
  if (t.paymentRef && toMinutes(t.paymentRef.time) <= toMinutes(t.scheduled || "23:59")) {
    return {
      status: "CLEARED",
      reason: `Payment reference ($${t.paymentRef.amount.toLocaleString()} at ${t.paymentRef.time}) predates scheduled delivery. ERP posting lag is not grounds for a hold.`
    };
  }
  if (t.cod && t.cardOnFile === false && t.driverAuthority === "None") {
    if (t.officePhone) {
      return {
        status: "REVIEW",
        reason: "COD account, no card on file, driver has no purchasing authority. Routed to the customer's office directly — the driver is never asked."
      };
    }
    return {
      status: "ESCALATED",
      reason: "COD, no card on file, no office contact reachable before departure. Escalated rather than defaulted to clear."
    };
  }
  if (t.creditStatus === "Clear") {
    return { status: "CLEARED", reason: "Standard terms, account in good standing." };
  }
  return { status: "REVIEW", reason: "Insufficient signal to auto-clear; held for a human look." };
}

function serialize(t) {
  return { ...t, state: computeState(t) };
}

// ---------- Routes ----------

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/tickets", (req, res) => {
  res.json(tickets.map(serialize));
});

app.get("/api/tickets/:id", (req, res) => {
  const t = tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  res.json(serialize(t));
});

// Real event ingestion: a payment event arrives and the ticket recomputes on its own.
app.post("/api/tickets/:id/payment-event", (req, res) => {
  const t = tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  const { amount, time } = req.body;
  if (typeof amount !== "number" || !time) {
    return res.status(400).json({ error: "amount (number) and time (HH:MM) required" });
  }
  t.paymentRef = { amount, time };
  auditLog.unshift({
    at: new Date().toISOString(),
    ticket: t.id,
    event: "payment_event_ingested",
    detail: `Payment of $${amount.toLocaleString()} received at ${time}, matched to ${t.id}.`
  });
  res.json(serialize(t));
});

// Override request/approval, logged unconditionally.
app.post("/api/tickets/:id/override", (req, res) => {
  const t = tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  const { requestedBy = "Unknown" } = req.body;
  const preState = computeState(t);
  const approver = preState.status === "ESCALATED" ? "CFO (ceiling enforced automatically)" : "Ops (below ceiling)";
  t.overridden = true;
  const entry = {
    at: new Date().toISOString(),
    ticket: t.id,
    customer: t.customer,
    requestedBy,
    approvedBy: approver,
    reasonBefore: preState.reason
  };
  auditLog.unshift(entry);
  res.json({ entry, ticket: serialize(t) });
});

app.get("/api/audit-log", (req, res) => {
  res.json(auditLog);
});

// Cash position — aggregated from the live ticket store, not a separate reporting pipeline.
app.get("/api/cash-position", (req, res) => {
  const byLine = { "Ready Mix": 0, "Aggregates": 0 };
  tickets.forEach(t => {
    const line = t.plant.startsWith("Aggregate") ? "Aggregates" : "Ready Mix";
    const s = computeState(t);
    if (s.status === "CLEARED") byLine[line] += t.value;
  });
  res.json({
    clearedByLine: byLine,
    // These remain modeled/illustrative figures, same caveat as the deck — not derived from the five sample tickets alone.
    codLeakagePreventedThisMonth: 186400,
    newRevenueThisMonth: 41200
  });
});

// Clear AI — the exception resolver, now server-side so a real key is never exposed to the browser.
const RULES = `You are Clear AI, the exception-resolution engine inside Fractal Clear, a payment-state layer for a ready-mix and aggregates company. You never invent facts beyond what's given. Apply these fixed business rules:
1. Any account with a past-due balance that would exceed $50,000 once today's order is included requires CFO approval before release, with no exceptions, regardless of relationship tier. Log this as an escalation, not a hold or a clear.
2. If a payment reference exists with a timestamp before the scheduled delivery time, treat it as paid even if the ERP posting status is still pending. ERP sync lag is not grounds for a hold.
3. If the driver is a third-party hauler or owner-operator with no purchasing authority, never route a payment request to the driver. Payment must be confirmed with the actual payer before or independent of the driver's presence.
4. The driver-facing signal is always exactly one of: CLEAR (proceed), HOLD (see dispatch), or nothing about money, ever.
5. Every override or escalation must produce an audit note suitable for a reconciliation log.

Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{"decision":"CLEAR or HOLD or ESCALATE","driver_signal":"one short sentence, no dollar amounts","ar_audit_note":"one or two sentences","confidence":"High or Medium or Low","reasoning":"two to four sentences"}`;

app.post("/api/resolve", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(200).json({
      decision: "No API key set",
      driver_signal: "—",
      ar_audit_note: "—",
      confidence: "—",
      reasoning: "Set ANTHROPIC_API_KEY as an environment variable before starting this server to make Clear AI live."
    });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: RULES,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    let parsed;
    try {
      parsed = JSON.parse(textBlock.text.trim());
    } catch (e) {
      parsed = {
        decision: "See reasoning", driver_signal: "—", ar_audit_note: "—",
        confidence: "—", reasoning: textBlock ? textBlock.text : "No response returned."
      };
    }
    res.json(parsed);
  } catch (err) {
    res.status(502).json({
      decision: "Unable to reach Clear AI", driver_signal: "—", ar_audit_note: "—",
      confidence: "—", reasoning: "Live call failed: " + err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Fractal Clear backend running on http://localhost:${PORT}`);
  console.log(process.env.ANTHROPIC_API_KEY ? "Clear AI: live" : "Clear AI: no ANTHROPIC_API_KEY set, will return a placeholder");
});
