import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* Prevent crash on aborted streams */
function isAbortError(err) {
  return err?.constructor?.name === 'APIUserAbortError'
    || err?.name === 'APIUserAbortError'
    || err?.message?.includes('Request was aborted');
}

process.on('uncaughtException', (err) => {
  if (isAbortError(err)) return;
  console.error('Uncaught:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  if (isAbortError(err)) return;
  console.error('Unhandled rejection:', err);
});
const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = join(__dirname, 'config.json');

/* ── Config persistence ── */
function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }
  return {};
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function getApiKey() {
  return loadConfig().apiKey || process.env.ANTHROPIC_API_KEY || null;
}

/* ── Express setup ── */
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

/* ── API key routes ── */
app.get('/api/key', (_req, res) => {
  res.json({ configured: !!getApiKey() });
});

app.post('/api/key', (req, res) => {
  const key = req.body.key?.trim();
  if (!key) return res.status(400).json({ error: 'Key required' });

  const cfg = loadConfig();
  cfg.apiKey = key;
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ── System prompt ── */
const SYSTEM = [
  'You are MakeBot -- an electronics engineer and maker educator.',
  '',
  'Given a project idea, produce a short, accurate, build-ready guide.',
  'IMPORTANT: Be CONCISE. Short descriptions, no filler. Get to the point.',
  '',
  '== FORMAT -- use this EXACT structure ==',
  '',
  '# [Creative Project Name]',
  '',
  '[1-2 sentences: what it does and the core principle.]',
  '',
  '## WIRING',
  '',
  '```',
  '[ASCII wiring diagram using box-drawing characters. Label both ends of every wire.]',
  '```',
  '',
  '[Short connection list: "Pin 9 -> Servo signal (orange)", one per line.]',
  '',
  '## PARTS',
  '',
  '- [qty]x [Part] -- [key spec only]',
  '',
  '## CODE',
  '',
  '```',
  '[Complete, compilable code. Pin numbers must match wiring. Comments on non-obvious lines only.]',
  '```',
  '',
  '## STEPS',
  '',
  '1. [Short, direct instruction]',
  '2. ...',
  '',
  'DO NOT include sections for Safety, How It Works, or Next Steps.',
  '',
  '== ACCURACY RULES ==',
  '',
  '- Use correct pin assignments for each board (Uno: D0-D13, A0-A5; ESP32: GPIO0-39 with input-only on 34-39; etc.)',
  '- Never assign PWM/I2C/SPI to wrong pins or exceed current limits',
  '- Include current-limiting resistors for LEDs, pull-ups for I2C/buttons, flyback diodes for motors',
  '- Never power multiple servos from Arduino 5V -- use external supply',
  '- Use real, available parts with exact values (e.g. "220ohm resistor" not "resistor")',
  '- Code must be complete and compilable -- no fragments',
  '- If the request is not a hardware project, say so briefly and suggest an example',
  '',
  'BREVITY: Keep the entire response under 300 lines. Shorter is better.',
].join('\n');

/* ── Simulation prompt ── */
const SIM_PROMPT = [
  'You are a Wokwi simulation expert. Given a hardware project build guide, generate the two files needed for a working Wokwi simulation.',
  '',
  'Respond with EXACTLY two fenced code blocks -- nothing else:',
  '1. ```json -- the diagram.json',
  '2. ```cpp -- the sketch.ino',
  '',
  '== DIAGRAM.JSON FORMAT ==',
  '',
  '{',
  '  "version": 1,',
  '  "author": "MakeBot",',
  '  "editor": "wokwi",',
  '  "parts": [',
  '    { "type": "wokwi-arduino-uno", "id": "uno", "top": 0, "left": 0, "attrs": {} }',
  '  ],',
  '  "connections": [',
  '    ["uno:5V", "servo1:V+", "red", []]',
  '  ]',
  '}',
  '',
  'PART TYPES & PIN NAMES:',
  '',
  'Boards:',
  '  wokwi-arduino-uno      -- pins: 0-13, A0-A5, 5V, 3.3V, GND.1, GND.2, VIN, AREF, SDA, SCL',
  '  wokwi-arduino-mega     -- pins: 0-53, A0-A15, 5V, 3.3V, GND.1-GND.5, VIN',
  '  wokwi-arduino-nano     -- pins: 0-13, A0-A7, 5V, 3.3V, GND.1, GND.2, VIN',
  '  wokwi-esp32-devkit-v1  -- pins: 0-39, 3V3, GND.1, GND.2, VIN, TX, RX',
  '',
  'Output:',
  '  wokwi-led              -- pins: A (anode +), C (cathode -) | attrs: { "color": "red" }',
  '  wokwi-rgb-led          -- pins: R, G, B, COM | attrs: { "common": "cathode" }',
  '  wokwi-servo            -- pins: PWM, V+, GND',
  '  wokwi-buzzer           -- pins: 1 (+), 2 (-)',
  '  wokwi-lcd1602          -- pins: VSS, VDD, V0, RS, RW, E, D4, D5, D6, D7, A, K (4-bit mode)',
  '  wokwi-ssd1306          -- pins: GND, VCC, SCL, SDA (I2C OLED)',
  '  wokwi-neopixel         -- pins: GND, VCC, DIN, DOUT | attrs: { "pixels": "8" }',
  '',
  'Input:',
  '  wokwi-pushbutton       -- pins: 1.l, 2.l, 1.r, 2.r (l=left, r=right; 1.l-1.r and 2.l-2.r are connected pairs)',
  '  wokwi-slide-switch     -- pins: 1, 2, 3 (common=2)',
  '  wokwi-potentiometer    -- pins: GND, SIG, VCC',
  '  wokwi-dht22            -- pins: VCC, SDA, NC, GND',
  '  wokwi-hc-sr04          -- pins: VCC, TRIG, ECHO, GND',
  '  wokwi-pir-motion-sensor-- pins: VCC, OUT, GND',
  '  wokwi-analog-joystick  -- pins: VCC, VERT, HORIZ, SEL, GND',
  '',
  'Passive:',
  '  wokwi-resistor         -- pins: 1, 2 | attrs: { "value": "220" } (ohms)',
  '  wokwi-photoresistor    -- pins: 1, 2',
  '',
  'CONNECTION FORMAT:',
  '  ["partId:pin", "partId:pin", "wireColor", [routingHints]]',
  '  Wire colors: "red"=power, "black"=ground, "green"/"blue"/"orange"/"yellow"/"purple"/"white"=signal',
  '  Routing hints: optional, use [] for auto-routing',
  '',
  'LAYOUT GUIDELINES:',
  '  - Board at top: 0, left: 0',
  '  - Place components spread out: increment top by ~120 and left by ~150 between parts',
  '  - Keep wiring clean -- avoid overlapping parts',
  '',
  '== SKETCH REQUIREMENTS ==',
  '',
  '- COMPLETE, compilable Arduino sketch -- not a fragment',
  '- #include all required libraries (Servo.h, Wire.h, LiquidCrystal.h, etc.)',
  '- Pin numbers MUST match diagram.json connections exactly',
  '- Include Serial.begin(115200) in setup() and Serial.println debug messages',
  '- Use descriptive variable names',
  '- Add comments for non-obvious logic',
  '- If a library is needed that Wokwi might not have, use a simpler built-in alternative',
  '',
  '== CRITICAL RULES ==',
  '',
  '- Every connection in diagram.json must use EXACT pin names listed above',
  '- Part IDs must be unique lowercase strings (e.g. "led1", "r1", "servo1")',
  '- Every part used in connections must be declared in the parts array',
  '- If the build guide uses components not available in Wokwi, substitute the closest available part and note it in a code comment',
  '- The simulation must DO something visible -- blink LEDs, move servos, print serial output',
  '- DO NOT include any text outside the two code blocks',
].join('\n');

/* ── Simulate endpoint ── */
app.post('/api/simulate', async (req, res) => {
  const { prompt, guide } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const apiKey = getApiKey();
  if (!apiKey) return res.status(401).json({ error: 'API key not configured' });

  try {
    /* Step 1: Generate Wokwi files via Claude */
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SIM_PROMPT,
      messages: [{
        role: 'user',
        content: `Project: ${prompt}\n\nBuild guide:\n${guide.slice(0, 6000)}`
      }],
    });

    const text = msg.content[0].text;
    const diagramMatch = text.match(/```json\s*\n([\s\S]*?)```/);
    const sketchMatch = text.match(/```(?:cpp|ino|arduino|c\+\+)\s*\n([\s\S]*?)```/);

    if (!diagramMatch || !sketchMatch) {
      throw new Error('Failed to generate simulation files');
    }

    const diagram = diagramMatch[1].trim();
    const sketch = sketchMatch[1].trim();

    /* Validate JSON */
    JSON.parse(diagram);

    /* Step 2: Save to Wokwi */
    const wokwiRes = await fetch('https://wokwi.com/api/projects/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': 'https://wokwi.com/projects/new/arduino-uno',
        'Origin': 'https://wokwi.com',
      },
      body: JSON.stringify({
        name: `MakeBot — ${prompt.slice(0, 60)}`,
        unlisted: true,
        files: [
          { name: 'sketch.ino', content: sketch },
          { name: 'diagram.json', content: diagram },
        ]
      })
    });

    if (!wokwiRes.ok) {
      const errText = await wokwiRes.text();
      throw new Error(`Wokwi error ${wokwiRes.status}: ${errText.slice(0, 200)}`);
    }

    const { projectId } = await wokwiRes.json();

    res.json({
      embedUrl: `https://wokwi.com/projects/${projectId}/embed?dark=1`,
      projectUrl: `https://wokwi.com/projects/${projectId}`,
    });

  } catch (err) {
    console.error('Simulate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Skill level context ── */
const SKILL_CONTEXT = {
  MONKEY: [
    'SKILL LEVEL: MONKEY -- Explain to a 6-year-old who has NEVER seen electronics.',
    '',
    'LANGUAGE: Use the simplest words. Fun analogies for everything. Color-based wire instructions.',
    'No jargon without kid-friendly explanation. No emoji.',
    'COMPONENTS: Max 4-5 parts. LEDs, resistors, buttons, buzzer, single servo only. Breadboard + jumpers only.',
    'STEPS: Say EXACTLY which hole/row/pin. Describe what parts look like. CHECKPOINT every 2 steps.',
    'CODE: Under 30 lines. Comment EVERY line in plain English.',
  ].join('\n'),

  NOVICE: [
    'SKILL LEVEL: NOVICE -- Has done 1-2 projects, knows what a breadboard is.',
    '',
    'LANGUAGE: Friendly, not dry. Briefly explain WHY each component is needed.',
    'COMPONENTS: 6-10 parts. Servos, basic sensors, LCDs, LEDs. Breadboard only.',
    'STEPS: Specific pin references. Checkpoint after each major section. Note common mistakes.',
    'CODE: Well-commented, grouped by function. Include library install steps.',
  ].join('\n'),

  BUILDER: [
    'SKILL LEVEL: BUILDER -- Comfortable with electronics and soldering.',
    '',
    'LANGUAGE: Technical but accessible. Explain non-obvious design decisions only.',
    'COMPONENTS: 10-20 parts. Motor drivers, relay modules, I2C/SPI sensors. Soldering OK.',
    'STEPS: Group by subsystem. Focus on connections, skip physical descriptions.',
    'CODE: Clean and structured. Comments on logic, not syntax.',
  ].join('\n'),

  HACKER: [
    'SKILL LEVEL: HACKER -- Experienced maker, wants no-fluff efficiency.',
    '',
    'LANGUAGE: Concise and direct. Focus on gotchas and tricky parts only.',
    'COMPONENTS: No restrictions. Raw ICs, MOSFETs, wireless modules. PCB suggestions welcome.',
    'STEPS: Skip obvious steps. Focus on non-trivial wiring and config.',
    'CODE: Advanced patterns -- interrupts, timers, register access. Performance-conscious.',
  ].join('\n'),

  EXPERT: [
    'SKILL LEVEL: EXPERT -- Professional engineer level.',
    '',
    'LANGUAGE: Peer-level technical. Focus on trade-offs and specifications.',
    'COMPONENTS: No restrictions. Raw MCUs, custom circuits, SMD, PCB layout considerations.',
    'STEPS: Minimal -- schematic-level design with critical implementation notes.',
    'CODE: Production-quality. Interrupt-driven, power-optimized, modular.',
  ].join('\n'),
};

/* ── Age context ── */
function ageContext(age) {
  if (age <= 8) return 'AGE: Young child (under 9). Use very simple language, fun descriptions, and always mention adult supervision for any step involving power or sharp tools.';
  if (age <= 12) return 'AGE: Kid (9-12). Use clear, friendly language. Mention asking an adult for help with soldering or power tools, but don\'t be overly cautious for simple wiring.';
  if (age <= 15) return 'AGE: Teen (13-15). Straightforward language. Only mention caution for genuinely dangerous steps (mains voltage, LiPo batteries, soldering). No hand-holding for basic tasks.';
  return 'AGE: ' + age + '+. Adult. No supervision warnings. No safety disclaimers unless the project involves genuinely hazardous voltages or chemicals. Write directly and efficiently.';
}

/* ── Generate (streaming) ── */
app.post('/api/generate', (req, res) => {
  const prompt = req.body.prompt?.trim();
  const skill = req.body.skill || 'MONKEY';
  const age = Number(req.body.age) || 25;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const apiKey = getApiKey();
  if (!apiKey) return res.status(401).json({ error: 'API key not configured — open settings' });

  const skillContext = SKILL_CONTEXT[skill] || SKILL_CONTEXT.MONKEY;
  const fullSystem = SYSTEM + '\n\n' + skillContext + '\n\n' + ageContext(age);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: fullSystem,
      messages: [{ role: 'user', content: prompt }],
    });

    let chunks = 0;

    stream.on('text', (text) => {
      chunks++;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ t: text })}\n\n`);
      }
    });

    stream.on('end', () => {
      console.log(`Stream ended — ${chunks} text chunks sent`);
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    stream.on('error', (err) => {
      if (isAbortError(err)) {
        console.log('Stream aborted (client disconnect)');
        return;
      }
      console.error('Stream error:', err.constructor.name, err.message);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    res.on('close', () => {
      if (!res.writableFinished) {
        console.log(`Client disconnected — chunks so far: ${chunks}`);
        try { stream.abort(); } catch {}
      }
    });
  } catch (err) {
    console.error('Setup error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n  MakeBot running → http://localhost:${PORT}\n`);
});
