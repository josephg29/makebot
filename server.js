import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rateLimit } from 'express-rate-limit';

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
const PORT = process.env.PORT || 4444;
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
app.disable('x-powered-by');

/* ── Rate limiting ── */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a moment' },
});
app.use('/api/', apiLimiter);

/* ── Security headers ── */
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; " +
    "frame-src https://wokwi.com; " +
    "img-src 'self' data:;"
  );
  next();
});

/* ── CORS: same-origin only ── */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || origin === `http://${host}` || origin === `https://${host}`) {
    return next();
  }
  res.status(403).json({ error: 'Cross-origin requests are not allowed' });
});

app.use(express.json());
app.use(express.static(join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  },
}));

/* ── API key routes ── */
app.get('/api/key', (_req, res) => {
  res.json({ configured: !!getApiKey() });
});

app.post('/api/key', (req, res) => {
  const key = req.body.key?.trim();
  if (!key) return res.status(400).json({ error: 'Key required' });
  if (!/^sk-ant-/.test(key)) return res.status(400).json({ error: 'Invalid key format — expected sk-ant-...' });

  const cfg = loadConfig();
  cfg.apiKey = key;
  saveConfig(cfg);
  res.json({ ok: true });
});

/* ── System prompt ── */
const SYSTEM = [
  'You are mertle.bot -- an electronics engineer and maker educator.',
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
  '  "author": "mertle.bot",',
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
  '- Use the correct library for the component (e.g. FastLED.h for NeoPixels, DHT.h for DHT22) -- required libraries will be auto-installed',
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

/* ── Arduino library auto-install for Wokwi ── */
const LIBRARY_MAP = {
  'FastLED.h':               'FastLED',
  'Adafruit_NeoPixel.h':     'Adafruit NeoPixel',
  'DHT.h':                   'DHT sensor library',
  'DHT_U.h':                 'DHT sensor library',
  'Adafruit_SSD1306.h':      'Adafruit SSD1306',
  'Adafruit_GFX.h':          'Adafruit GFX Library',
  'Adafruit_BME280.h':       'Adafruit BME280 Library',
  'Adafruit_BMP280.h':       'Adafruit BMP280 Library',
  'Adafruit_MPU6050.h':      'Adafruit MPU6050',
  'Adafruit_ADXL345_U.h':    'Adafruit ADXL345',
  'Adafruit_HMC5883_U.h':    'Adafruit HMC5883 Unified',
  'Adafruit_Unified_Sensor.h':'Adafruit Unified Sensor',
  'LiquidCrystal_I2C.h':     'LiquidCrystal I2C',
  'IRremote.h':               'IRremote',
  'IRremoteESP8266.h':        'IRremoteESP8266',
  'Keypad.h':                 'Keypad',
  'TM1637Display.h':          'TM1637Display',
  'ezButton.h':               'ezButton',
  'RTClib.h':                 'RTClib',
  'DS1307RTC.h':              'DS1307RTC',
  'TimeLib.h':                'Time',
  'MFRC522.h':                'MFRC522',
  'Encoder.h':                'Encoder',
  'PID_v1.h':                 'PID',
  'ArduinoJson.h':            'ArduinoJson',
  'PubSubClient.h':           'PubSubClient',
  'U8g2lib.h':                'U8g2',
  'MAX6675.h':                'MAX6675 library',
  'HX711.h':                  'HX711',
  'Stepper28BYJ.h':           'Stepper28BYJ',
  'AccelStepper.h':           'AccelStepper',
  'NewPing.h':                'NewPing',
  'Ultrasonic.h':             'Ultrasonic',
  'SoftwareSerial.h':         'SoftwareSerial',
  'AltSoftSerial.h':          'AltSoftSerial',
  'NTPClient.h':              'NTPClient',
  'WiFiUdp.h':                'WiFi',
  'AsyncTCP.h':               'AsyncTCP',
  'ESPAsyncWebServer.h':      'ESPAsyncWebServer',
};

// Headers that ship with Arduino core / ESP32 core -- no install needed
const BUILTIN_HEADERS = new Set([
  'Arduino.h','Wire.h','SPI.h','Servo.h','EEPROM.h','LiquidCrystal.h',
  'Stepper.h','SD.h','SD_MMC.h','FS.h','SPIFFS.h','LittleFS.h',
  'WiFi.h','WiFiClient.h','WiFiServer.h','HTTPClient.h','WebServer.h',
  'BluetoothSerial.h','BLEDevice.h','BLEServer.h','BLEUtils.h','BLE2902.h',
  'HardwareSerial.h','IPAddress.h','Ticker.h','esp_system.h',
  'avr/pgmspace.h','avr/io.h','avr/interrupt.h','util/delay.h',
  'math.h','stdio.h','string.h','stdlib.h',
]);

function extractLibraries(sketch) {
  const headers = [...sketch.matchAll(/#include\s*<([^>]+)>/g)].map(m => m[1]);
  return [...new Set(
    headers.flatMap(h => (!BUILTIN_HEADERS.has(h) && LIBRARY_MAP[h]) ? [LIBRARY_MAP[h]] : [])
  )];
}

/* ── Simulate endpoint ── */
app.post('/api/simulate', async (req, res) => {
  const { prompt, guide } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  if (!guide) return res.status(400).json({ error: 'Guide required' });
  if (prompt.length > 600) return res.status(400).json({ error: 'Prompt too long (max 600 characters)' });

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
    const libs = extractLibraries(sketch);
    const files = [
      { name: 'sketch.ino',   content: sketch },
      { name: 'diagram.json', content: diagram },
    ];
    if (libs.length > 0) {
      files.push({ name: 'libraries.txt', content: libs.join('\n') });
    }

    const wokwiRes = await fetch('https://wokwi.com/api/projects/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': 'https://wokwi.com/projects/new/arduino-uno',
        'Origin': 'https://wokwi.com',
      },
      body: JSON.stringify({
        name: `mertle.bot — ${prompt.slice(0, 60)}`,
        unlisted: true,
        files,
      })
    });

    if (!wokwiRes.ok) {
      const errText = await wokwiRes.text();
      throw new Error(`Wokwi error ${wokwiRes.status}: ${errText.slice(0, 200)}`);
    }

    const { projectId } = await wokwiRes.json();

    res.json({
      embedUrl: `https://wokwi.com/projects/${projectId}/embed?dark=1&view=diagram`,
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

/* ── Chat system prompt (for non-build conversations) ── */
const CHAT_SYSTEM = [
  'You are mertle.bot -- a friendly electronics engineer and maker educator.',
  '',
  'The user is chatting with you, NOT requesting a build guide.',
  'Answer their question, have a conversation, or help them brainstorm.',
  'Be concise and helpful. Use your electronics/maker expertise when relevant.',
  'Do NOT produce a build guide unless the user explicitly asks you to build or make something.',
  'Keep responses short and conversational.',
].join('\n');

/* ── Intent classifier ── */
async function classifyIntent(client, prompt) {
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: 'Classify the user message. Reply with EXACTLY one word: BUILD if they want you to design/create/generate a specific hardware project or build guide (e.g. "make me an LED blinker", "build a robot arm", "I want a temperature sensor project"), or CHAT for anything else (questions, conversation, brainstorming, asking for help, asking what you can do, greetings, clarifications, opinions, vague ideas without a concrete project request). When in doubt, reply CHAT. Reply with only BUILD or CHAT, nothing else.',
      messages: [{ role: 'user', content: prompt }],
    });
    const answer = res.content[0].text.trim().toUpperCase();
    return answer === 'BUILD' ? 'BUILD' : 'CHAT';
  } catch (err) {
    console.error('Intent classification failed, defaulting to BUILD:', err.message);
    return 'BUILD';
  }
}

/* ── Return 405 for wrong-method requests ── */
app.get('/api/generate', (_req, res) => {
  res.set('Allow', 'POST').status(405).json({ error: 'Method Not Allowed — use POST' });
});

/* ── Generate (streaming) ── */
app.post('/api/generate', async (req, res) => {
  const prompt = req.body.prompt?.trim();
  const skill = req.body.skill || 'MONKEY';
  const age = Number(req.body.age) || 25;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  if (prompt.length > 50000) return res.status(400).json({ error: 'Prompt too long' });

  const apiKey = getApiKey();
  if (!apiKey) return res.status(401).json({ error: 'API key not configured — open settings' });

  const client = new Anthropic({ apiKey });

  /* Classify intent before streaming */
  const intent = await classifyIntent(client, prompt);
  console.log(`Intent: ${intent} — "${prompt.slice(0, 60)}"`);

  const skillContext = SKILL_CONTEXT[skill] || SKILL_CONTEXT.MONKEY;
  const buildSystem = SYSTEM + '\n\n' + skillContext + '\n\n' + ageContext(age);
  const chatSystem = CHAT_SYSTEM + '\n\n' + ageContext(age);
  const fullSystem = intent === 'BUILD' ? buildSystem : chatSystem;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  /* Send intent hint to frontend so it knows whether this is a build */
  res.write(`data: ${JSON.stringify({ intent })}\n\n`);

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: intent === 'BUILD' ? 4096 : 1024,
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

/* ── Global error handler (suppress stack traces in responses) ── */
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n  mertle.bot (E — Master) running → http://localhost:${PORT}\n`);
});
