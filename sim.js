// Rustworks — shared deterministic simulation.
// Runs identically on the server (Node) and in every browser: lockstep multiplayer.
// RULES: no Math.random, no Date/performance, no transcendental math that feeds state.
(function (root) {
'use strict';

// =====================================================================
//  constants
// =====================================================================
const T = 32, W = 448, H = 320;   // procedurally generated per world seed
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const DIRN = ['north', 'east', 'south', 'west'];
const DT = 1 / 60;
const BELT_SPEED = 1 / 30, GAP = 0.25, INS_STEP = 1 / 22;
const CHEST_CAP = 800, RESIDUE_CAP = 4000, PIPE_CAP = 100, BIN_CAP = 150;
const TRUCK_CAP = 90;            // tonnes
const EXC_RATE = 4;              // t/s
const EXC_REACH = 3;             // tiles from excavator centre
const FEEDER_RATE = 4;           // t/s
const DIESEL_EXC = .025;         // litres/s while digging (~90 L/h)
const DIESEL_TILE = [.3, .55];   // litres per tile, empty / loaded
const ALUMINA_PER_FEED = 10;     // fluid units of dense-phase alumina per pot shot
const WELL_RATE = 12;            // crude units/s per oil well
const PAD_RP1 = 360, PAD_LOX = 800;   // propellant load for one launch
const BLAST_R = 5;
const BUG_HP = 3, BUG_SPEED = 1.6 / 60, BUG_DPS = 8, MAX_BUGS = 160;
const RAID_START = 60 * 60 * 10;     // 10 minutes' grace before the first raids
const TURRET_R = 9, TURRET_ROUNDS = 40, SHOOT_R = 12;
const SENTRY_R = 6, SENTRY_COOL = 45, SENTRY_START = 60;   // tripod: 0.75 s between shots
// ---- mining physics
const BUCKET_M3 = 12;                                   // excavator bucket, heaped
const EXC_CYCLE = 300, STRIP_CYCLE = 240, REHANDLE_CYCLE = 240;   // ticks per dig-swing-dump-return cycle
const TRUCK_M3 = 60;                                    // heaped body volume: light ore fills the body before the scales
// loose (broken) density, t/m³. In situ rock is 30-40 % denser: it swells when blasted and dug.
const DENS = { bauxite: 1.45, coal: .9, limestone: 1.6, coke: .7, gibbsite: 1, redmud: 1.3, rombx: 1.45, romcoal: .9, romlime: 1.6 };
const SWELL = { bauxite: 1.38, coal: 1.35, limestone: 1.6 };
const capOf = m => Math.min(TRUCK_CAP, Math.floor(TRUCK_M3 * (DENS[m] || 1.4)));
const ROM_OF = { bauxite: 'rombx', coal: 'romcoal', limestone: 'romlime' };
const CRUSHED = { rombx: 'bauxite', romcoal: 'coal', romlime: 'limestone' };
const ROM_PAD = 300, CRUSH_RATE = 5;                    // t on the run-of-mine pad; t/s through the jaw
const BENCH_T = 300;                                    // tonnes per bench lift on one tile
const DRILL_R = 6, DRILL_T = 240, PATTERN = 6, FUSE = 240;   // a pattern of 6 holes takes 1 ANFO crate per 2 holes
const GRADER_R = 28, GRADER_SPEED = 1.6 / 60, TAIL_CAP = 50000;
const DEF_G = [46, 5];                                  // Al₂O₃ %, reactive SiO₂ % of bauxite of unknown origin
const GRADED = new Set(['bauxite', 'rombx']);
const TILE_M = 10;                                      // a tile is 10 m across

// =====================================================================
//  items & fluids
// =====================================================================
const ITEMS = {
  bauxite:   { n: 'Bauxite', u: 't', d: 'Lateritic ore: gibbsite Al(OH)₃ and boehmite with Fe₂O₃ (the red), SiO₂ and TiO₂. ~45–50 % Al₂O₃.' },
  rombx:     { n: 'ROM bauxite', u: 't', d: 'Run-of-mine bauxite: dug lumps up to a metre, clay and caprock. Crush it before it goes anywhere.' },
  romcoal:   { n: 'ROM coal', u: 't', d: 'Run-of-mine coal with shale partings, straight from the face. Crush it before use.' },
  romlime:   { n: 'ROM limestone', u: 't', d: 'Blasted limestone in big lumps. Crush it before use.' },
  anfo:      { n: 'ANFO (crate)', d: 'Ammonium nitrate / fuel oil blasting agent with boosters and detonators. One crate charges two blast holes.' },
  coal:      { n: 'Coal', u: 't', d: 'Thermal coal: fuel for boilers, kilns, the calciner and the power station.' },
  limestone: { n: 'Limestone', u: 't', d: 'CaCO₃. Burned in the lime kiln to quicklime.' },
  coke:      { n: 'Calcined pet coke', u: 't', d: 'Anode aggregate, ~65 % of the paste.' },
  gibbsite:  { n: 'Alumina hydrate', u: 't', d: 'Al(OH)₃ filter cake from the precipitators.' },
  redmud:    { n: 'Red mud', u: 't', d: 'Bauxite residue: Fe₂O₃, TiO₂, sodalite. pH ≈ 13. It must be stored.' },
  quicklime: { n: 'Quicklime (bags)', d: 'CaO. Dosed at digestion to precipitate phosphate/carbonate.' },
  caustic:   { n: 'Caustic soda (bags)', d: 'NaOH. Make-up for soda lost to desilication product and residue.' },
  flocculant:{ n: 'Flocculant (drum)', d: 'Hydroxamate/polyacrylate. Makes red mud settle in the thickener.' },
  pitch:     { n: 'Coal-tar pitch (drum)', d: 'Anode binder, ~15 % of the paste.' },
  green:     { n: 'Green anode', d: 'Vibro-compacted, unbaked anode block.' },
  anode:     { n: 'Rodded baked anode', d: 'Baked at ~1,100 °C; aluminium stem + steel stub cast in.' },
  butt:      { n: 'Anode butt', d: 'Spent anode remnant (~20 %). Cleaned and recycled into paste.' },
  cryolite:  { n: 'Cryolite (bags)', d: 'Na₃AlF₆: the molten electrolyte (“bath”).' },
  alf3:      { n: 'Aluminium fluoride (bags)', d: 'AlF₃. Keeps the bath acidic.' },
  crucible:  { n: 'Crucible of molten Al', d: 'Siphon-tapped metal at ~960 °C.' },
  ingot:     { n: 'P1020 ingot bundle', d: '99.7 % Al, a 1 t bundle of 22 kg ingots.' },
  concrete:  { n: 'Precast concrete', d: 'Foundations, plinths and walls. Construction material.' },
  alu:       { n: 'Aluminium extrusions', d: '6061 structural sections pressed from your ingots. Construction material.' },
  kit:       { n: 'Machinery kit', d: 'Motors, gearboxes, switchgear, instruments. Construction material, arrives by supply allocation.' },
  cement:    { n: 'Portland cement (bags)', d: 'Clinker ground with gypsum. Binder for concrete.' },
  lithium:   { n: 'Lithium metal (drum)', d: 'Battery-grade Li under argon. ~1 % Li makes Al-Li 2195 lighter and stiffer.' },
  copper:    { n: 'Copper cathode', d: 'Cu cathode for CuCrZr chamber liners — conducts heat out of the throat.' },
  superalloy:{ n: 'Inconel 718 billet', d: 'Nickel superalloy for turbopumps, injectors and chamber jackets.' },
  avionics:  { n: 'Avionics kit', d: 'Triple-redundant flight computers, IMU, GNSS, telemetry, harnesses.' },
  ammo:      { n: 'Ammunition (crate)', d: '40 rounds to a crate. Feeds tripod sentries and autocannon turrets.' },
  paykit:    { n: 'Payload kit', d: 'Area-denial package for the bug colonies. Needs a fairing and integration.' },
  slab:      { n: 'Al-Li 2195 slab', d: 'Direct-chill cast slab, homogenised.' },
  plate:     { n: 'Al-Li plate', d: 'Hot-rolled, solution-treated and stretched plate.' },
  tank:      { n: 'Tank barrel section', d: 'Friction-stir welded barrel with orthogrid stiffening.' },
  turbopump: { n: 'Turbopump', d: 'Single-shaft LOX/RP-1 pumps on a gas-generator turbine, 30,000 rpm.' },
  chamber:   { n: 'Thrust chamber', d: 'CuCrZr regeneratively cooled liner, Inconel jacket, pintle injector.' },
  engine:    { n: 'Engine (untested)', d: 'Gas-generator cycle engine, awaiting hot-fire acceptance.' },
  engineok:  { n: 'Flight engine', d: 'Passed hot-fire acceptance. Cleared for flight.' },
  payload:   { n: 'Encapsulated payload', d: 'Payload inside a composite/Al-Li fairing.' },
  rocket:    { n: 'Launch vehicle', d: '4-engine kerolox rocket. Rolls out to an adjacent launch pad.' },
};
// Bulk solids go by truck and feeder. Unit loads go by belt and inserter.
const BULK = new Set(['bauxite', 'coal', 'limestone', 'coke', 'gibbsite', 'redmud', 'rombx', 'romcoal', 'romlime']);
const NOHANDLE = new Set(['rocket']);   // moved by crawler, never by inserter
const FLUIDS = {
  water:     { n: 'Water', col: '#3d8fd1' },
  steam:     { n: 'Steam', col: '#d9dcdf' },
  liquor:    { n: 'Caustic liquor', col: '#8a5fc9' },
  slurry:    { n: 'Bauxite slurry', col: '#b4552b' },
  digested:  { n: 'Digested slurry', col: '#d7802f' },
  pregnant:  { n: 'Pregnant liquor', col: '#a7b54a' },
  mudslurry: { n: 'Red mud underflow', col: '#8c2b18' },
  alumina:   { n: 'Alumina (dense-phase)', col: '#f2f0ea' },
  crude:     { n: 'Crude oil', col: '#2a2420' },
  naphtha:   { n: 'Naphtha', col: '#e6c84a' },
  kerosene:  { n: 'Straight-run kerosene', col: '#c9a35b' },
  residue:   { n: 'Vacuum residue', col: '#141210' },
  hydrogen:  { n: 'Hydrogen', col: '#e04f9a' },
  rp1:       { n: 'RP-1', col: '#f08a24' },
  lox:       { n: 'Liquid oxygen', col: '#7fd4ff' },
  tailings:  { n: 'Wash tailings', col: '#a0805a' },
};
// No money: supply allocations deliver imports at fixed rates (units or tonnes per minute, per depot).
const ALLOC = { kit: 4, caustic: 30, flocculant: 12, pitch: 20, cryolite: 15, alf3: 15, coke: 60, coal: 120, limestone: 90, lithium: 4, copper: 6, superalloy: 6, avionics: 1.5, paykit: 1, ammo: 20, anfo: 12 };
const IMPORTS = Object.keys(ALLOC);
const START_STORES = { concrete: 400, alu: 300, kit: 160 };
const MATS = ['concrete', 'alu', 'kit'];

// =====================================================================
//  buildings
// =====================================================================
const P = (x, y, d, f, io) => ({ x, y, d, f, io });
const DEFS = {
  belt:      { n: 'Conveyor belt', w: 1, h: 1, cost: 50, desc: 'Carries unit loads: bags, drums, anodes, crucibles, ingots. Not for bulk.' },
  inserter:  { n: 'Inserter', w: 1, h: 1, cost: 300, desc: 'Moves unit loads from the tile behind to the tile in front.' },
  pipe:      { n: 'Pipe', w: 1, h: 1, cost: 80, desc: 'Connected pipes form one network that carries ONE fluid. Coloured bands show the contents.' },
  ptg:       { n: 'Underground pipe', w: 1, h: 1, cost: 400, desc: 'Pairs with an underground pipe facing it up to 10 tiles away. Crosses roads and belts.' },
  chest:     { n: 'Storage crate', w: 1, h: 1, cost: 150, desc: 'Holds 800 unit loads.' },
  road:      { n: 'Haul road', w: 1, h: 1, cost: 120, desc: 'Two-lane compacted road. Trucks keep right. Junctions let one truck through at a time unless signalled.' },
  signal:    { n: 'Traffic signal', w: 1, h: 1, cost: 8000, tool: true, desc: 'Place on a road junction (3+ roads). Vehicle-actuated: green goes to the approach with trucks waiting.' },
  truck:     { n: 'Haul truck', w: 1, h: 1, cost: 180000, tool: true, desc: '90 t rigid-frame dump truck. Place on a road. The dispatcher assigns it to excavators, bins and hoppers. Burns diesel.' },
  hopper:    { n: 'Dump hopper', w: 2, h: 2, cost: 20000, desc: 'Trucks tip into it from the road on its arrow side. Choose its material in the inspector. Unload it with an apron feeder.' },
  bin:       { n: 'Load-out bin', w: 2, h: 2, cost: 20000, desc: 'Fill it with an apron feeder; trucks load from the road on its arrow side.' },
  feeder:    { n: 'Apron feeder', w: 1, h: 1, cost: 2500, desc: 'Moves BULK from the tile behind to the tile in front at 4 t/s (hopper → machine, machine → bin).' },
  excavator: { n: 'Hydraulic excavator', w: 3, h: 3, cost: 220000, desc: 'Place on any open land, or drive it (E). Strips overburden, then digs ore within 3 tiles into a truck at its arrow side, or onto a stockpile beside it. Diesel.' },
  pit:       { n: 'Pit outline', w: 1, h: 1, cost: 0, tool: true, desc: 'Drag a rectangle to lay out an open pit (drag again over it to remove). Excavators and drill rigs that reach the pit work only inside it, bench by bench.' },
  drill:     { n: 'Drill rig', w: 2, h: 2, cost: 60000, desc: 'Track-mounted blast-hole drill. Drills stripped hard rock within 6 tiles in patterns of 6 holes, charges them with ANFO (by inserter, 1 crate per 2 holes) and fires. Unblasted hard rock digs at a crawl. Diesel.' },
  crusher:   { n: 'Primary crusher', w: 3, h: 3, cost: 90000, power: 1.2, desc: 'Run-of-mine pad (300 t) and jaw crusher. Trucks tip ROM ore from any adjacent road. Crushed ore leaves by apron feeder at up to 5 t/s.' },
  washplant: { n: 'Bauxite wash plant', w: 3, h: 4, cost: 70000, power: .6, desc: 'Log washer, scrubber and screens strip clay and fines from crushed bauxite: higher Al₂O₃, about half the reactive silica gone, 8-18 % of the mass lost. Tailings slurry leaves by pipe.',
               ports: [P(0, 3, 2, 'water', 'in'), P(2, 0, 0, 'tailings', 'out')] },
  tailings:  { n: 'Tailings dam', w: 5, h: 5, cost: 25000, desc: 'Clay-lined pond with a decant tower. Takes wash tailings by pipe (south port). 50,000 units.', ports: [P(2, 4, 2, 'tailings', 'in')] },
  grader:    { n: 'Grader shed', w: 2, h: 2, cost: 30000, desc: 'Houses a motor grader. It works haul roads within 28 tiles, cutting out the ruts that slow loaded trucks and burn their fuel. Needs a road beside the shed. Diesel.' },
  pump:      { n: 'Offshore pump', w: 1, h: 1, cost: 8000, desc: 'Place on the shoreline with its back to the water. 60 water/s.', ports: [P(0, 0, 0, 'water', 'out')] },
  substation:{ n: 'Grid connection', w: 2, h: 2, cost: 25000, cap: 30, desc: 'Buys up to 30 MW from the national grid at $20/MW·s. Used after your own generation.' },
  powerplant:{ n: 'Coal power station', w: 5, h: 5, cost: 280000, cap: 25, desc: 'Steam turbine-generator. Coal via apron feeder, plus cooling water. 25 MW.',
               ports: [P(2, 4, 2, 'water', 'in')], stacks: [[126, 28, 'smoke'], [126, 80, 'smoke']] },
  boiler:    { n: 'Process steam boiler', w: 2, h: 3, cost: 40000, power: .05, desc: 'Raises process steam for the digesters.',
               ports: [P(0, 2, 2, 'water', 'in'), P(0, 0, 0, 'steam', 'out')], recipes: [{ t: 4, i: { coal: 1 }, fi: { water: 200 }, fo: { steam: 200 } }], stacks: [[46, 66, 'smoke']] },
  dissolver: { n: 'Caustic make-up tank', w: 2, h: 2, cost: 15000, power: .1, desc: 'Dissolves NaOH bags in water to charge the liquor circuit and replace losses.',
               ports: [P(0, 1, 2, 'water', 'in'), P(1, 0, 0, 'liquor', 'out')], recipes: [{ t: 1, i: { caustic: 1 }, fi: { water: 50 }, fo: { liquor: 50 } }] },
  mill:      { n: 'Ball mill', w: 3, h: 3, cost: 60000, power: 1.2, desc: 'Wet-grinds crushed bauxite in caustic liquor to a pumpable slurry. Slurry yield follows the ore\'s Al₂O₃; reactive silica eats extra liquor (desilication product).',
               ports: [P(1, 2, 2, 'liquor', 'in'), P(1, 0, 0, 'slurry', 'out')], recipes: [{ t: 2, i: { bauxite: 2 }, fi: { liquor: 40 }, fo: { slurry: 40 } }] },
  digester:  { n: 'Digester train', w: 3, h: 3, cost: 90000, power: .4, desc: 'Autoclaves at 145 °C dissolve gibbsite into sodium aluminate.',
               ports: [P(0, 2, 2, 'slurry', 'in'), P(2, 2, 2, 'steam', 'in'), P(1, 0, 0, 'digested', 'out')],
               recipes: [{ t: 2, i: { quicklime: .2 }, fi: { slurry: 40, steam: 20 }, fo: { digested: 40 } }], stacks: [[84, 12, 'steam']] },
  clarifier: { n: 'Settler / thickener', w: 5, h: 5, cost: 80000, power: .2, desc: 'Red mud settles with flocculant. Clear pregnant liquor overflows; mud leaves as underflow (east).',
               ports: [P(2, 4, 2, 'digested', 'in'), P(2, 0, 0, 'pregnant', 'out'), P(4, 2, 1, 'mudslurry', 'out')],
               recipes: [{ t: 2, i: { flocculant: .1 }, fi: { digested: 40 }, fo: { pregnant: 30, mudslurry: 10 } }] },
  washer:    { n: 'Mud washer + filter', w: 3, h: 3, cost: 45000, power: .3, desc: 'Counter-current washing recovers soda. Filtered mud leaves as bulk (feeder → bin → truck).',
               ports: [P(0, 2, 2, 'mudslurry', 'in'), P(2, 2, 2, 'water', 'in'), P(1, 0, 0, 'liquor', 'out')],
               recipes: [{ t: 2, fi: { mudslurry: 10, water: 10 }, fo: { liquor: 8 }, o: { redmud: 1 } }] },
  precipitator:{ n: 'Precipitator + filter', w: 3, h: 3, cost: 40000, power: .3, desc: 'Cooled and seeded, Al(OH)₃ crystallises and is filtered off as bulk hydrate.',
               ports: [P(1, 2, 2, 'pregnant', 'in'), P(1, 0, 0, 'liquor', 'out')],
               recipes: [{ t: 3, fi: { pregnant: 30 }, fo: { liquor: 27 }, o: { gibbsite: 1 } }] },
  limekiln:  { n: 'Lime kiln', w: 2, h: 3, cost: 30000, power: .1, desc: 'CaCO₃ → CaO + CO₂. Output is bagged.',
               recipes: [{ t: 4, i: { limestone: 2, coal: .5 }, o: { quicklime: 1 } }], stacks: [[32, 30, 'smoke']] },
  calciner:  { n: 'Rotary calciner', w: 3, h: 6, cost: 150000, power: .6, desc: '2 Al(OH)₃ → Al₂O₃ + 3 H₂O at ~1,050 °C. Alumina leaves by dense-phase pneumatic pipe.',
               ports: [P(1, 0, 0, 'alumina', 'out')],
               recipes: [{ t: 3, i: { gibbsite: 3, coal: .5 }, fo: { alumina: 20 } }], stacks: [[78, 14, 'steam']] },
  paste:     { n: 'Anode paste plant', w: 3, h: 3, cost: 70000, power: .8, desc: 'Coke (bulk) + pitch drums (+ recycled butts) → green anodes.',
               recipes: [{ t: 3, i: { butt: 1, coke: 1, pitch: 1 }, o: { green: 2 } }, { t: 3, i: { coke: 2, pitch: 1 }, o: { green: 2 } }], stacks: [[80, 18, 'steam']] },
  bake:      { n: 'Anode baking furnace', w: 3, h: 6, cost: 110000, power: .3, desc: 'Open-top ring furnace: the fire travels section to section.',
               recipes: [{ t: 6, i: { green: 2, coal: 1 }, o: { anode: 2 } }], stacks: [[84, 10, 'smoke']] },
  pot:       { n: 'Hall–Héroult reduction cell', w: 3, h: 5, cost: 60000, power: 1.5, desc: 'Alumina (pipe, south) in molten cryolite at ~960 °C, 4.2 V / 350 kA. Anodes and bath chemicals by inserter. Loses heat fast without power.',
               ports: [P(1, 4, 2, 'alumina', 'in')] },
  casthouse: { n: 'Casthouse', w: 4, h: 4, cost: 90000, power: .5, desc: 'Holding furnace + ingot casting line.',
               recipes: [{ t: 2, i: { crucible: 1 }, o: { ingot: 1 } }], stacks: [[100, 22, 'steam']] },
  depot:     { n: 'Supply depot', w: 3, h: 3, cost: 10000, desc: 'Receives one supply allocation at a fixed rate. Unit goods are unloaded by inserter; bulk goods load onto trucks at adjacent roads.' },
  store:     { n: 'Site stores', w: 2, h: 2, cost: 12000, desc: 'Team construction stockpile. Anything inserted here can be spent on building by every player.' },
  cementkiln:{ n: 'Cement kiln', w: 2, h: 4, cost: 40000, power: .8, desc: 'Burns limestone to clinker at 1,450 °C and grinds it to bagged cement.',
               recipes: [{ t: 4, i: { limestone: 3, coal: .5 }, o: { cement: 2 } }], stacks: [[32, 20, 'smoke']] },
  batching:  { n: 'Concrete batching plant', w: 3, h: 3, cost: 30000, power: .4, desc: 'Cement + limestone aggregate + water, cast into precast panels.',
               ports: [P(1, 2, 2, 'water', 'in')], recipes: [{ t: 4, i: { cement: 1, limestone: 2 }, fi: { water: 20 }, o: { concrete: 2 } }] },
  extrusion: { n: 'Extrusion press', w: 3, h: 4, cost: 60000, power: 1.5, desc: 'Reheats ingot logs and pushes them through a die: structural sections.',
               recipes: [{ t: 3, i: { ingot: 1 }, o: { alu: 3 } }] },
  residue:   { n: 'Residue storage area', w: 5, h: 5, cost: 30000, desc: 'Lined dry-stack area. Trucks tip red mud from any adjacent road. 4,000 t.' },
  // ---- oil & propellants
  oilwell:   { n: 'Oil well', w: 2, h: 2, cost: 60000, power: .3, desc: 'Beam pump on an oil seep. 12 crude/s until the reservoir under it is drawn down.',
               ports: [P(0, 0, 0, 'crude', 'out')] },
  distill:   { n: 'Crude distillation unit', w: 3, h: 5, cost: 160000, power: 1, desc: 'Atmospheric + vacuum columns split crude into naphtha, kerosene and vacuum residue.',
               ports: [P(1, 4, 2, 'crude', 'in'), P(2, 4, 2, 'steam', 'in'), P(0, 0, 0, 'naphtha', 'out'), P(1, 0, 0, 'kerosene', 'out'), P(2, 0, 0, 'residue', 'out')],
               recipes: [{ t: 2, fi: { crude: 50, steam: 10 }, fo: { naphtha: 15, kerosene: 20, residue: 15 } }], stacks: [[16, 10, 'smoke']] },
  coker:     { n: 'Delayed coker', w: 3, h: 4, cost: 120000, power: .6, desc: 'Thermally cracks residue in drums: green pet coke (bulk, for anodes) + cracked naphtha.',
               ports: [P(1, 3, 2, 'residue', 'in'), P(1, 0, 0, 'naphtha', 'out')],
               recipes: [{ t: 3, fi: { residue: 20 }, fo: { naphtha: 6 }, o: { coke: 1 } }], stacks: [[24, 14, 'smoke']] },
  reformer:  { n: 'Steam reformer', w: 3, h: 3, cost: 90000, power: .6, desc: 'Naphtha + steam over nickel catalyst at 850 °C → hydrogen (PSA-purified). Vents CO₂.',
               ports: [P(0, 2, 2, 'naphtha', 'in'), P(2, 2, 2, 'steam', 'in'), P(1, 0, 0, 'hydrogen', 'out')],
               recipes: [{ t: 2, fi: { naphtha: 10, steam: 20 }, fo: { hydrogen: 30 } }], stacks: [[80, 14, 'smoke']] },
  hydrotreater:{ n: 'Kerosene hydrotreater', w: 3, h: 3, cost: 90000, power: .5, desc: 'Strips sulphur and olefins from kerosene over CoMo catalyst → RP-1 rocket kerosene.',
               ports: [P(0, 2, 2, 'kerosene', 'in'), P(2, 2, 2, 'hydrogen', 'in'), P(1, 0, 0, 'rp1', 'out')],
               recipes: [{ t: 2, fi: { kerosene: 20, hydrogen: 5 }, fo: { rp1: 18 } }] },
  asu:       { n: 'Air separation unit', w: 4, h: 4, cost: 200000, power: 6, desc: 'Compresses, cools and distils air in a cold box → liquid oxygen. Hungry for power.',
               ports: [P(0, 3, 2, 'water', 'in'), P(3, 0, 0, 'lox', 'out')],
               recipes: [{ t: 2, fi: { water: 10 }, fo: { lox: 20 } }] },
  // ---- vehicle manufacture
  alloy:     { n: 'Al-Li casting pit', w: 3, h: 3, cost: 80000, power: .8, desc: 'Melts your ingots with lithium under argon and DC-casts 2195 slabs.',
               recipes: [{ t: 6, i: { ingot: 5, lithium: 1 }, o: { slab: 1 } }], stacks: [[80, 18, 'steam']] },
  rolling:   { n: 'Plate rolling mill', w: 3, h: 6, cost: 180000, power: 4, desc: 'Reheat, hot-roll, solution-treat, stretch: slab → plate.',
               recipes: [{ t: 4, i: { slab: 1 }, o: { plate: 4 } }] },
  tankshop:  { n: 'Friction-stir tank shop', w: 4, h: 4, cost: 150000, power: 1, desc: 'Machines orthogrid into plate, rolls it and friction-stir welds barrel sections.',
               recipes: [{ t: 10, i: { plate: 6 }, o: { tank: 1 } }] },
  turbo:     { n: 'Turbomachinery cell', w: 3, h: 3, cost: 120000, power: .6, desc: '5-axis machining + balancing of impellers, inducers and turbine disks.',
               recipes: [{ t: 12, i: { superalloy: 2 }, o: { turbopump: 1 } }] },
  chamberfab:{ n: 'Thrust chamber shop', w: 3, h: 3, cost: 120000, power: .6, desc: 'Mills cooling channels in a CuCrZr liner, closes it with an Inconel jacket, welds the injector.',
               recipes: [{ t: 12, i: { copper: 1, superalloy: 1 }, o: { chamber: 1 } }] },
  engineasm: { n: 'Engine assembly', w: 3, h: 3, cost: 60000, power: .3, desc: 'Mates chamber, turbopump, gas generator, valves and plumbing.',
               recipes: [{ t: 8, i: { chamber: 1, turbopump: 1 }, o: { engine: 1 } }] },
  teststand: { n: 'Engine test stand', w: 4, h: 5, cost: 140000, power: .2, desc: 'Hot-fires each engine for acceptance. ~4 % fail and are scrapped.',
               ports: [P(0, 4, 2, 'rp1', 'in'), P(3, 4, 2, 'lox', 'in')],
               recipes: [{ t: 6, i: { engine: 1 }, fi: { rp1: 40, lox: 100 }, o: { engineok: 1 } }] },
  payloadfab:{ n: 'Payload processing', w: 3, h: 3, cost: 70000, power: .2, desc: 'Encapsulates the payload kit in a fairing made from plate.',
               recipes: [{ t: 10, i: { plate: 2, paykit: 1 }, o: { payload: 1 } }] },
  vab:       { n: 'Vehicle assembly building', w: 5, h: 7, cost: 300000, power: 1.5, desc: 'Stacks tanks, 4 flight engines, avionics and payload into a rocket. Put a launch pad right next to it.',
               recipes: [{ t: 30, i: { tank: 4, engineok: 4, avionics: 2, payload: 1 }, o: { rocket: 1 } }] },
  sentry:    { n: 'Tripod sentry', w: 1, h: 1, cost: 8000, desc: 'Cheap starter defence: a 12.7 mm machine gun on a tripod. Slow to fire, 6-tile reach, no power needed. Comes with 60 rounds; refill with ammunition crates by inserter.' },
  turret:    { n: 'Autocannon turret', w: 2, h: 2, cost: 40000, power: .2, desc: 'Radar-cued 30 mm autocannon. Engages bugs within 9 tiles. Ammunition crates by inserter.' },
  pad:       { n: 'Launch pad', w: 6, h: 6, cost: 400000, power: .5, desc: 'Takes a rocket from an adjacent VAB, loads RP-1 and LOX (LOX boils off), then launches at a bug colony.',
               ports: [P(0, 5, 2, 'rp1', 'in'), P(5, 5, 2, 'lox', 'in')] },
};
const GROUPS = [
  ['Logistics', ['belt', 'inserter', 'pipe', 'ptg', 'chest']],
  ['Haulage', ['road', 'signal', 'truck', 'hopper', 'bin', 'feeder']],
  ['Mining', ['pit', 'excavator', 'drill', 'crusher', 'washplant', 'tailings', 'grader']],
  ['Power & water', ['pump', 'substation', 'powerplant', 'boiler']],
  ['Refinery', ['dissolver', 'mill', 'digester', 'clarifier', 'washer', 'precipitator', 'limekiln', 'calciner']],
  ['Smelter', ['paste', 'bake', 'pot', 'casthouse']],
  ['Oil & propellant', ['oilwell', 'distill', 'coker', 'reformer', 'hydrotreater', 'asu']],
  ['Rocketry', ['alloy', 'rolling', 'tankshop', 'turbo', 'chamberfab', 'engineasm', 'teststand', 'payloadfab', 'vab', 'pad']],
  ['Defence', ['sentry', 'turret']],
  ['Supply & stores', ['depot', 'store', 'residue', 'cementkiln', 'batching', 'extrusion']],
];
const POT_IN = { anode: 2, cryolite: 3, alf3: 3 };
const COSTS = {
  belt: { alu: 1 }, inserter: { alu: 1, kit: 1 }, pipe: { alu: 1 }, ptg: { alu: 2 }, chest: { alu: 2 }, road: {}, signal: { alu: 1, kit: 1 },
  truck: { alu: 4, kit: 6 }, hopper: { concrete: 6, alu: 2 }, bin: { concrete: 2, alu: 6 }, feeder: { alu: 2, kit: 1 }, excavator: { alu: 4, kit: 8 }, pit: {}, drill: { alu: 3, kit: 4 }, crusher: { concrete: 8, alu: 3, kit: 4 }, washplant: { concrete: 5, alu: 3, kit: 3 }, tailings: { concrete: 6 }, grader: { concrete: 2, alu: 3, kit: 4 },
  pump: { concrete: 2, kit: 1 }, turret: { concrete: 3, alu: 3, kit: 2 }, sentry: { alu: 1, kit: 1 }, substation: { concrete: 4, kit: 2 }, store: { concrete: 4, alu: 2 }, depot: { concrete: 4, alu: 2 }, residue: { concrete: 4 },
  cementkiln: { concrete: 4, alu: 2, kit: 2 }, batching: { concrete: 3, alu: 2, kit: 2 }, extrusion: { concrete: 4, alu: 2, kit: 3 },
};
function costOf(type) {
  if (COSTS[type]) return COSTS[type];
  const c = DEFS[type].cost, o = {};
  o.concrete = Math.max(1, Math.round(c / 8000)); o.alu = Math.max(1, Math.round(c / 15000)); o.kit = Math.max(1, Math.round(c / 40000));
  return COSTS[type] = o;
}
for (const k in DEFS) {
  const d = DEFS[k]; d.ilim = {}; d.flim = {}; d.olim = {}; d.folim = {};
  for (const r of d.recipes || []) {
    for (const i in r.i || {}) d.ilim[i] = Math.max(d.ilim[i] || 0, Math.max(2, Math.ceil(r.i[i] * 2)));
    for (const f in r.fi || {}) d.flim[f] = Math.max(d.flim[f] || 0, r.fi[f] * 2);
    for (const o in r.o || {}) d.olim[o] = Math.max(d.olim[o] || 0, Math.max(4, r.o[o] * 2));
    for (const f in r.fo || {}) d.folim[f] = Math.max(d.folim[f] || 0, r.fo[f] * 2.5);
  }
}
DEFS.pot.ilim = POT_IN; DEFS.pot.flim = { alumina: 40 };
DEFS.powerplant.ilim = { coal: 4 }; DEFS.powerplant.flim = { water: 60 };
DEFS.pad.flim = { rp1: PAD_RP1, lox: PAD_LOX };
DEFS.turret.ilim = { ammo: 4 };
DEFS.sentry.ilim = { ammo: 2 };
DEFS.vab.olim = { rocket: 1 };
DEFS.drill.ilim = { anfo: 6 };
DEFS.washplant.ilim = { bauxite: 8 }; DEFS.washplant.olim = { bauxite: 10 }; DEFS.washplant.flim = { water: 80 }; DEFS.washplant.folim = { tailings: 120 };
DEFS.tailings.flim = { tailings: 200 };

// =====================================================================
//  noise (pure integer/IEEE arithmetic — identical on every engine)
// =====================================================================
function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, s) => vnoise(x, y, s) * .55 + vnoise(x * 2, y * 2, s + 1) * .28 + vnoise(x * 4, y * 4, s + 2) * .17;

// =====================================================================
//  world generation
// =====================================================================
// engine-independent sine (only + - * /), so every browser builds the same coastline
function dsin(v) {
  const TAU = 6.283185307179586; v -= Math.floor(v / TAU + .5) * TAU;
  const v2 = v * v; let t = v, sum = v;
  for (let n = 1; n < 12; n++) { t *= -v2 / ((2 * n) * (2 * n + 1)); sum += t; }
  return sum;
}
// Everything below is a pure function of SEED, so every client rebuilds the identical world from 4 bytes.
let SEED = 1;
const SPAWN = { x: 0, y: 0 };
const sd = k => (Math.imul(SEED, 7919) + Math.imul(k, 104729)) | 0;
function waterField(x, y) {
  const wx = x + (vnoise(x / 40, y / 40, sd(1)) - .5) * 34, wy = y + (vnoise(x / 40, y / 40, sd(2)) - .5) * 34;   // domain warp
  const lake = (fbm(wx / 30, wy / 30, sd(3)) - .71) * 7;
  const river = (.014 - Math.abs(fbm(wx / 95, wy / 95, sd(4)) - .5)) * 50;
  return Math.max(lake, river);
}
const water = new Uint8Array(W * H);
const isWater = (x, y) => x < 0 || y < 0 || x >= W || y >= H || water[x + y * W] === 1;
const oreType = new Array(W * H).fill(null), oreAmt = new Int32Array(W * H), ob = new Float32Array(W * H);
const oreInit = new Array(W * H).fill(null), oreInitAmt = new Int32Array(W * H), obInit = new Float32Array(W * H);
// geology (pure functions of the seed, rebuilt on every client): hardness, bauxite assay, ground elevation
const hard = new Uint8Array(W * H);          // 0 soft (digs free), 1 medium, 2 hard (blast it first)
const gA = new Float32Array(W * H), gS = new Float32Array(W * H);   // Al₂O₃ %, reactive SiO₂ %
const elev0 = new Float32Array(W * H);       // natural ground, metres
// mutable mine state
const frag = new Uint8Array(W * H);          // 1 = blasted (fragmented rock)
const pit = new Uint8Array(W * H);           // 1 = inside a laid-out pit
const landAround = (x, y, r) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (isWater(x + i, y + j)) return false; return true; };
function findSpawn() {
  const sx = Math.round(W * .2), sy = Math.round(H * .5);
  for (let r = 0; r < 160; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
    if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
    if (landAround(sx + i, sy + j, 9)) { SPAWN.x = sx + i; SPAWN.y = sy + j; return; }
  }
  SPAWN.x = sx; SPAWN.y = sy;
}
// Scarce by design: small, thin patches near the landing site; richer, larger deposits far out (and nearer the bugs).
const ORE_BASE = { bauxite: [500, 1200], coal: [300, 700], limestone: [300, 700], oil: [4000, 8000] };
function paintPatch(t, px, py, rad, rich, k) {
  for (let y = Math.max(0, Math.floor(py - rad * 1.5)); y <= Math.min(H - 1, Math.ceil(py + rad * 1.5)); y++)
    for (let x = Math.max(0, Math.floor(px - rad * 1.5)); x <= Math.min(W - 1, Math.ceil(px + rad * 1.5)); x++) {
      const i = x + y * W; if (water[i] || oreType[i]) continue;
      const dx = x - px, dy = y - py, d = Math.sqrt(dx * dx + dy * dy) / rad + (vnoise(x * .3, y * .3, sd(50 + k)) - .5) * .7;
      if (d >= 1) continue;
      oreType[i] = t;
      oreAmt[i] = Math.round((ORE_BASE[t][0] + (1 - d) * ORE_BASE[t][1]) * rich);
      ob[i] = t === 'oil' ? 0 : Math.round(12 + vnoise(x * .4, y * .4, sd(90)) * 30 + d * 15);
    }
}
let patchList = [];
function genWorld(seed) {
  SEED = seed | 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) water[x + y * W] = waterField(x + .5, y + .5) > 0 ? 1 : 0;
  findSpawn();
  oreType.fill(null); oreAmt.fill(0); ob.fill(0);
  const r = mulberry(sd(9)), P = [];
  const clear = (x, y, rad) => landAround(Math.round(x), Math.round(y), 1) && P.every(q => (q[1] - x) * (q[1] - x) + (q[2] - y) * (q[2] - y) > (q[3] + rad + 6) * (q[3] + rad + 6));
  // one small starter deposit of each, a walk away from the landing site
  for (const [t, rad, dist] of [['bauxite', 4.5, 22], ['coal', 3, 17], ['limestone', 2.6, 24], ['oil', 2.2, 36]]) {
    for (let k = 0; k < 400; k++) {
      let dx = r() * 2 - 1, dy = r() * 2 - 1; const l = Math.sqrt(dx * dx + dy * dy); if (l < .3 || l > 1) continue;
      const dd = dist * (.85 + r() * .4) + k * .05, x = SPAWN.x + dx / l * dd, y = SPAWN.y + dy / l * dd;
      if (x < 4 || y < 4 || x > W - 5 || y > H - 5 || !clear(x, y, rad)) continue;
      P.push([t, x, y, rad, 1]); break;
    }
  }
  // the wider world
  const want = Math.round(W * H / 2900), TYPES = ['bauxite', 'bauxite', 'bauxite', 'coal', 'coal', 'limestone', 'limestone', 'oil'];
  for (let k = 0; k < 6000 && P.length < want; k++) {
    const x = 6 + r() * (W - 12), y = 6 + r() * (H - 12), d = Math.sqrt((x - SPAWN.x) * (x - SPAWN.x) + (y - SPAWN.y) * (y - SPAWN.y));
    if (d < 45) continue;
    const t = TYPES[(r() * TYPES.length) | 0], rad = (t === 'oil' ? 2.2 : 3) + r() * 2.5 + Math.min(4, d / 90);
    if (!clear(x, y, rad)) continue;
    P.push([t, x, y, rad, 1 + Math.min(1.5, d / 180)]);
  }
  P.forEach(([t, x, y, rad, rich], k) => paintPatch(t, x, y, rad, rich, k));
  patchList = P;
  for (let i = 0; i < W * H; i++) { oreInit[i] = oreType[i]; oreInitAmt[i] = oreAmt[i]; obInit[i] = ob[i]; }
  hard.fill(0); gA.fill(0); gS.fill(0); frag.fill(0); pit.fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = x + y * W, t = oreType[i];
    elev0[i] = fbm(x / 70, y / 70, sd(70)) * 42 + vnoise(x / 14, y / 14, sd(71)) * 5;
    if (t === 'limestone') hard[i] = 2;
    else if (t === 'coal') hard[i] = 1;
    else if (t === 'bauxite') {
      hard[i] = vnoise(x / 5, y / 5, sd(72)) > .52 ? 2 : 0;   // ferricrete caprock in places, soft earthy ore elsewhere
      const d = Math.sqrt((x - SPAWN.x) * (x - SPAWN.x) + (y - SPAWN.y) * (y - SPAWN.y));
      gA[i] = Math.round((38 + fbm(x / 9, y / 9, sd(73)) * 14 + Math.min(4, d / 60)) * 10) / 10;
      gS[i] = Math.round((1.5 + (1 - fbm(x / 7, y / 7, sd(74))) * 10) * 10) / 10;
    }
  }
}
function hiveSites() {
  const r = mulberry(sd(31)), out = [];
  for (let k = 0; k < 5000 && out.length < 14; k++) {
    const x = 4 + Math.floor(r() * (W - 8)), y = 4 + Math.floor(r() * (H - 8));
    if ((x - SPAWN.x) * (x - SPAWN.x) + (y - SPAWN.y) * (y - SPAWN.y) < 170 * 170 || !landAround(x, y, 2)) continue;
    if (out.some(([a, b]) => (a - x) * (a - x) + (b - y) * (b - y) < 30 * 30)) continue;
    out.push([x, y]);
  }
  return out;
}
const isOre = i => !!oreType[i] && oreType[i] !== 'oil';
// depth of the hole dug in a tile (m), and ground elevation including it
const depthM = i => (obInit[i] - ob[i]) * .08 + (oreInitAmt[i] - (oreType[i] ? oreAmt[i] : 0)) / 180 * (oreInit[i] === 'oil' ? 0 : 1);
const elevAt = i => elev0[i] - depthM(i);
const benchOf = i => Math.floor((oreInitAmt[i] - oreAmt[i]) / BENCH_T) + (ob[i] > 0 ? 0 : 1);
const needsBlast = i => isOre(i) && hard[i] > 0 && !frag[i];
const digFactor = i => !needsBlast(i) ? 1 : hard[i] === 2 ? .15 : .45;   // unblasted rock: low fill factor, long cycles
// bug colonies
const creep = new Uint8Array(W * H);
const hives = [], flights = [];
let nextHive = 1;
const bugs = [];
let nextBug = 1;

// =====================================================================
//  state
// =====================================================================
const cells = new Array(W * H).fill(null);
const ents = [];
const trucks = [];
const heaps = [];   // loose ore stockpiles and spoil heaps on the ground: { x, y (tile units), m ('spoil' or an ore), t, ga, gs }
let nets = [];
let tick = 0, rs = 1234567, satP = 1, satO = 1, nextTruck = 1;
const stores = { ...START_STORES };
const stats = { bugsKilled: 0, lost: 0, rounds: 0, made: {}, fmade: {}, used: {}, delivered: {}, co2: 0, mud: 0, frozen: 0, ae: 0, potHot: 0, gridMWs: 0, diesel: 0, hauled: 0, launches: 0, kills: 0, enginefail: 0, crude: 0 };
const power = { cap: 0, plantCap: 0, gridCap: 0, demand: 0, potDemand: 0, used: 0, fromGrid: 0 };
const hooks = { onDeplete() {}, onStrip() {}, onEvent() {}, onCmd() {}, onCreep() {}, onDig() {}, onPit() {} };
function rand() { rs = rs + 0x6D2B79F5 | 0; let t = Math.imul(rs ^ rs >>> 15, 1 | rs); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
const madeAdd = (k, n = 1) => stats.made[k] = (stats.made[k] || 0) + n;
const burnDiesel = l => { stats.diesel = (stats.diesel || 0) + l; stats.co2 += l * .0027; };
function canAfford(c) { for (const k in c) if ((stores[k] || 0) < c[k]) return false; return true; }
function shortOf(c) { const m = []; for (const k in c) if ((stores[k] || 0) < c[k]) m.push(k); return m; }
function pay(c) { for (const k in c) { stores[k] -= c[k]; stats.used[k] = (stats.used[k] || 0) + c[k]; } }
function refund(c, f) { for (const k in c) stores[k] = (stores[k] || 0) + Math.floor(c[k] * f); }

// =====================================================================
//  entities
// =====================================================================
const get = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? null : cells[x + y * W];
const fp = (type, dir) => { const d = DEFS[type]; return dir % 2 ? [d.h, d.w] : [d.w, d.h]; };
const isRoadI = i => { const e = cells[i]; return !!e && e.type === 'road'; };
function l2w(e, lx, ly) {
  const d = DEFS[e.type], [fw, fh] = fp(e.type, e.dir);
  const cx = (e.x + fw / 2) * T, cy = (e.y + fh / 2) * T, ox = lx - d.w * T / 2, oy = ly - d.h * T / 2;
  switch (e.dir) { case 0: return [cx + ox, cy + oy]; case 1: return [cx - oy, cy + ox]; case 2: return [cx - ox, cy - oy]; default: return [cx + oy, cy - ox]; }
}
function computePorts(e) {
  e.ports = (DEFS[e.type].ports || []).map(p => {
    const [wx, wy] = l2w(e, (p.x + .5) * T, (p.y + .5) * T);
    const tx = Math.floor(wx / T), ty = Math.floor(wy / T), wd = (p.d + e.dir) % 4;
    return { ...p, wd, mx: tx, my: ty, tx: tx + DX[wd], ty: ty + DY[wd], net: null, pipe: null };
  });
}
function makeEnt(type, x, y, dir) {
  const e = { type, x, y, dir, status: 'Idle', wants: 0, anim: 0 };
  if (type === 'belt') { e.items = []; e.curve = -1; }
  else if (type === 'inserter') { e.a = 0; e.hand = null; }
  else if (type === 'pipe' || type === 'ptg') { e.con = [0, 0, 0, 0]; e.net = null; }
  else if (type === 'chest') { e.inv = {}; e.total = 0; }
  else if (type === 'feeder') { e.flow = 0; }
  else if (type === 'hopper' || type === 'bin') { e.mat = null; e.stock = 0; e.incoming = 0; }
  else if (type === 'excavator') { e.dig = -1; e.mat = null; e.acc = 0; e.swing = 0; e.target = -1; e.cyc = 0; e.job = null; e.passes = 0; }
  else if (type === 'road') { e.sig = null; e.wear = 0; }
  else {
    e.inb = {}; e.outb = {}; e.fin = {}; e.fout = {}; e.active = null; e.prog = 0;
    if (type === 'pot') Object.assign(e, { T: 25, al: 0, bath: 0, xs: 11, carbon: 0, metal: 0, frozen: false, ae: false, hot: false, freezeT: 0, ce: 0, volt: 0, feedFlash: 0 });
    if (type === 'powerplant') { e.fuelE = 0; e.gen = 0; }
    if (type === 'depot') { e.sel = 'kit'; e.acc = 0; e.stock = 0; e.mat = null; }
    if (type === 'residue') { e.fill = 0; e.incoming = 0; }
    if (type === 'crusher') { e.mat = null; e.stock = 0; e.incoming = 0; e.flow = 0; }
    if (type === 'tailings') e.fill = 0;
    if (type === 'drill') { e.holes = []; e.cur = -1; e.dprog = 0; e.fuse = 0; e.lx = x + 1; e.ly = y + 1; e.rhx = 0; e.rhy = -1; }
    if (type === 'grader') { e.gt = -1; e.gn = -1; e.gp = 0; e.path = []; e.gh = 1; }
    if (type === 'sentry') { e.rounds = SENTRY_START; e.cool = 0; e.aimX = x + .5; e.aimY = y - 3; e.shotT = -99; }
    if (type === 'turret') { e.rounds = 0; e.cool = 0; e.aimX = x + 1; e.aimY = y - 3; e.shotT = -99; }
    if (type === 'pad') { e.rocket = false; e.auto = false; e.launchT = 0; e.boil = 0; }
  }
  computePorts(e);
  return e;
}
function excTiles(x, y) {   // diggable tiles around an excavator anchored at x,y (3x3)
  const out = [], cx = x + 1, cy = y + 1;
  for (let j = -EXC_REACH; j <= EXC_REACH; j++) for (let i = -EXC_REACH; i <= EXC_REACH; i++) {
    const tx = cx + i, ty = cy + j;
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    if (Math.abs(i) <= 1 && Math.abs(j) <= 1) continue;
    out.push(tx + ty * W);
  }
  return out;
}
function placeError(type, x, y, dir) {
  const [fw, fh] = fp(type, dir); let ore = 0;
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) {
    const cx = x + i, cy = y + j;
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return 'Outside the map';
    if (water[cx + cy * W]) return 'On water';
    if (cells[cx + cy * W]) return 'Occupied';
    if (oreType[cx + cy * W]) ore++;
  }
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) if (creep[x + i + (y + j) * W]) return 'Infested ground';
  if (type === 'oilwell') { let o = 0; for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) if (oreType[x + i + (y + j) * W] === 'oil') o++; if (!o) return 'Needs an oil seep'; }
  if (type === 'pump' && !isWater(x - DX[dir], y - DY[dir])) return 'Needs water behind it';
  return null;
}
const canPlace = (type, x, y, dir) => !placeError(type, x, y, dir);
function place(type, x, y, dir, free, pid) {
  if (!DEFS[type] || DEFS[type].tool || !canPlace(type, x, y, dir)) return null;
  const cost = costOf(type);
  if (!free) { if (!canAfford(cost)) { hooks.onEvent('nomats', { pid, type, short: shortOf(cost) }); return null; } pay(cost); }
  const e = makeEnt(type, x, y, dir);
  const [fw, fh] = fp(type, dir);
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) cells[x + i + (y + j) * W] = e;
  ents.push(e); rebuild();
  return e;
}
function removeEnt(e, pid) {
  if (e.type === 'road') {
    const i = e.x + e.y * W;
    if (trucks.some(t => t.tile === i || t.next === i)) { hooks.onEvent('truckblock', { pid }); return false; }
    if (e.sig) refund(costOf('signal'), 1);
  }
  const [fw, fh] = fp(e.type, e.dir);
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) cells[e.x + i + (e.y + j) * W] = null;
  ents.splice(ents.indexOf(e), 1);
  e.dead = true;
  refund(costOf(e.type), 1);
  rebuild();
  return true;
}
function rotateEnt(e, d) {
  if (e.type === 'belt' || e.type === 'inserter' || e.type === 'ptg' || e.type === 'feeder') { e.dir = (e.dir + d) % 4; rebuild(); return; }
  const [fw, fh] = fp(e.type, e.dir);
  if (fw !== fh || ['chest', 'depot', 'store', 'residue', 'road', 'pipe'].includes(e.type)) return;
  e.dir = (e.dir + d) % 4; computePorts(e); rebuild();
}
function rebuild() { refreshBelts(); rebuildNets(); }

// =====================================================================
//  belts
// =====================================================================
const feeds = (e, x, y) => e && e.type === 'belt' && e.x + DX[e.dir] === x && e.y + DY[e.dir] === y;
function refreshBelts() {
  for (const b of ents) {
    if (b.type !== 'belt') continue;
    b.curve = -1;
    if (feeds(get(b.x - DX[b.dir], b.y - DY[b.dir]), b.x, b.y)) continue;
    const l = (b.dir + 3) % 4, r = (b.dir + 1) % 4;
    const lf = feeds(get(b.x + DX[l], b.y + DY[l]), b.x, b.y), rf = feeds(get(b.x + DX[r], b.y + DY[r]), b.x, b.y);
    if (lf !== rf) b.curve = lf ? l : r;
  }
}
function beltPoint(b, p) {
  const cx = b.x * T + 16, cy = b.y * T + 16, ex = cx + DX[b.dir] * 16, ey = cy + DY[b.dir] * 16;
  if (b.curve < 0) { const sx = cx - DX[b.dir] * 16, sy = cy - DY[b.dir] * 16; return [sx + (ex - sx) * p, sy + (ey - sy) * p]; }
  const sx = cx + DX[b.curve] * 16, sy = cy + DY[b.curve] * 16, q = 1 - p;
  return [q * q * sx + 2 * q * p * cx + p * p * ex, q * q * sy + 2 * q * p * cy + p * p * ey];
}
const canInsert = (b, p) => b.items.every(i => Math.abs(i.pos - p) >= GAP);
function insertItem(b, it, p) { it.pos = p; b.items.push(it); b.items.sort((a, c) => c.pos - a.pos); }
function entryPos(a, b) {
  const from = (a.dir + 2) % 4;
  if (a.dir === b.dir || b.curve === from) return 'o';
  if (a.dir === (b.dir + 2) % 4) return null;
  return .5;
}
function updateBelt(b) {
  const out = [];
  for (const it of b.items) {
    let np = it.pos + (it.tk === tick ? 0 : BELT_SPEED); it.tk = tick;
    if (!out.length && np >= 1) {
      const n = get(b.x + DX[b.dir], b.y + DY[b.dir]);
      if (n && n.type === 'belt') {
        const e = entryPos(b, n);
        if (e !== null) { const p = e === 'o' ? np - 1 : e; if (canInsert(n, p)) { insertItem(n, it, p); continue; } }
      }
      np = 1;
    }
    const lim = out.length ? out[out.length - 1].pos - GAP : 1;
    it.pos = Math.max(it.pos, Math.min(np, lim));
    out.push(it);
  }
  b.items = out;
}

// =====================================================================
//  fluids
// =====================================================================
const isPipe = e => !!e && (e.type === 'pipe' || e.type === 'ptg');
const pipeSide = (e, d) => e.type === 'pipe' || d === (e.dir + 2) % 4;
function rebuildNets() {
  for (const n of nets) { const s = n.pipes.length ? n.amt / n.pipes.length : 0; for (const p of n.pipes) { p._a = s; p._f = n.fluid; } }
  nets = [];
  const pipes = ents.filter(isPipe);
  for (const p of pipes) { p.net = null; p.con = [0, 0, 0, 0]; p.under = null; if (p._a === undefined) { p._a = 0; p._f = null; } }
  for (const p of pipes) if (p.type === 'ptg') for (let k = 1; k <= 10; k++) {
    const q = get(p.x + DX[p.dir] * k, p.y + DY[p.dir] * k);
    if (q && q.type === 'ptg' && q.dir === (p.dir + 2) % 4) { p.under = q; break; }
  }
  for (const p of pipes) for (let d = 0; d < 4; d++) {
    if (!pipeSide(p, d)) continue;
    const n = get(p.x + DX[d], p.y + DY[d]);
    if (isPipe(n) && pipeSide(n, (d + 2) % 4)) p.con[d] = 1;
  }
  for (const m of ents) if (m.ports) for (const pt of m.ports) {
    pt.net = null; pt.pipe = null;
    const p = get(pt.tx, pt.ty), side = (pt.wd + 2) % 4;
    if (isPipe(p) && pipeSide(p, side)) { p.con[side] = 2; pt.pipe = p; }
  }
  for (const p of pipes) {
    if (p.net) continue;
    const net = { fluid: null, amt: 0, cap: 0, pipes: [] }, st = [p], tot = {};
    p.net = net;
    while (st.length) {
      const q = st.pop(); net.pipes.push(q); net.cap += PIPE_CAP;
      if (q._f && q._a > 0) tot[q._f] = (tot[q._f] || 0) + q._a;
      const nb = []; for (let d = 0; d < 4; d++) if (q.con[d] === 1) nb.push(get(q.x + DX[d], q.y + DY[d]));
      if (q.under) nb.push(q.under);
      for (const r of nb) if (r && !r.net) { r.net = net; st.push(r); }
    }
    let best = null; for (const f in tot) if (!best || tot[f] > tot[best]) best = f;
    net.fluid = best; net.amt = best ? Math.min(net.cap, tot[best]) : 0;
    nets.push(net);
  }
  for (const m of ents) if (m.ports) for (const pt of m.ports) if (pt.pipe) pt.net = pt.pipe.net;
  for (const p of pipes) { delete p._a; delete p._f; }
}
function portExchange(m) {
  const d = DEFS[m.type];
  for (const pt of m.ports) {
    const n = pt.net; if (!n) continue;
    if (n.amt <= .01) { n.amt = 0; n.fluid = null; }
    if (pt.io === 'in') {
      if (n.fluid !== pt.f) continue;
      const cap = d.flim[pt.f], have = m.fin[pt.f] || 0, mv = Math.min(cap - have, n.amt);
      if (mv > 0) { m.fin[pt.f] = have + mv; n.amt -= mv; }
    } else {
      const have = m.fout[pt.f] || 0; if (have <= 0) continue;
      if (n.fluid && n.fluid !== pt.f) continue;
      const mv = Math.min(have, n.cap - n.amt);
      if (mv > 0) { n.fluid = pt.f; n.amt += mv; m.fout[pt.f] = have - mv; }
    }
  }
}

// =====================================================================
//  unit-load transfer (belts / inserters)
// =====================================================================
function accepts(t, item) {
  if (!t) return false;
  switch (t.type) {
    case 'belt': case 'chest': return !BULK.has(item);
    case 'store': return !BULK.has(item) && !NOHANDLE.has(item);
    case 'turret': return item === 'ammo' && (t.inb.ammo || 0) < 4;
    case 'sentry': return item === 'ammo' && (t.inb.ammo || 0) < 2;
    case 'residue': case 'inserter': case 'pipe': case 'ptg': case 'pump': case 'substation': case 'depot':
    case 'road': case 'feeder': case 'hopper': case 'bin': case 'excavator': case 'crusher': case 'tailings': case 'grader': return false;
    default: { if (BULK.has(item)) return false; const L = DEFS[t.type].ilim[item]; return !!L && (t.inb[item] || 0) < L; }
  }
}
function give(t, item, fx, fy) {
  if (!accepts(t, item)) return false;
  if (t.type === 'belt') { if (!canInsert(t, .5)) return false; insertItem(t, { type: item, rx: fx, ry: fy, tk: tick }, .5); return true; }
  if (t.type === 'chest') { if (t.total >= CHEST_CAP) return false; t.inv[item] = (t.inv[item] || 0) + 1; t.total++; return true; }
  if (t.type === 'store') { stores[item] = (stores[item] || 0) + 1; stats.delivered[item] = (stats.delivered[item] || 0) + 1; t.anim += 1; return true; }
  t.inb[item] = (t.inb[item] || 0) + 1; return true;
}
function take(s, ok) {
  if (!s) return null;
  if (s.type === 'belt') {
    let best = -1;
    s.items.forEach((it, i) => { if (ok(it.type) && (best < 0 || Math.abs(it.pos - .5) < Math.abs(s.items[best].pos - .5))) best = i; });
    return best < 0 ? null : s.items.splice(best, 1)[0].type;
  }
  if (s.type === 'chest') { for (const k in s.inv) if (s.inv[k] > 0 && ok(k)) { s.inv[k]--; s.total--; return k; } return null; }
  if (s.outb) for (const k in s.outb) if (s.outb[k] >= 1 && !BULK.has(k) && !NOHANDLE.has(k) && ok(k)) { s.outb[k]--; return k; }
  return null;
}

// =====================================================================
//  ore grade: mass-weighted blending as bauxite moves (pile, truck, hopper, pad, plant)
// =====================================================================
function blendG(o, pa, ps, have, add, g) {
  if (add <= 0) return;
  const a = o[pa] === undefined ? DEF_G[0] : o[pa], b = o[ps] === undefined ? DEF_G[1] : o[ps], h = have > 0 ? have : 0;
  o[pa] = (a * h + g[0] * add) / (h + add); o[ps] = (b * h + g[1] * add) / (h + add);
}
const gradeOf = (o, pa = 'ga', ps = 'gs') => [o[pa] === undefined ? DEF_G[0] : o[pa], o[ps] === undefined ? DEF_G[1] : o[ps]];
// which grade fields hold the bulk a source gives up / a target takes in
const outFields = s => s.type === 'hopper' || s.type === 'bin' ? ['ga', 'gs'] : ['oga', 'ogs'];
const inFields = t => t.type === 'hopper' || t.type === 'bin' || t.type === 'crusher' ? ['ga', 'gs'] : ['ga', 'gs'];

// =====================================================================
//  bulk transfer (feeders)
// =====================================================================
function bulkAvail(s) {   // -> [material, tonnes]
  if (!s) return [null, 0];
  if (s.type === 'hopper' || s.type === 'bin') return [s.mat, s.stock];
  if (s.type === 'tailings') return [null, 0];
  if (s.outb) for (const k in s.outb) if (BULK.has(k) && s.outb[k] > 1e-9) return [k, s.outb[k]];
  return [null, 0];
}
function bulkRoom(t, m) {
  if (!t) return 0;
  if (t.type === 'bin') return t.mat === null || t.mat === m || t.stock < 1e-6 ? BIN_CAP - t.stock : 0;
  if (t.type === 'hopper') return t.mat === m ? BIN_CAP - t.stock - 0 : 0;
  if (t.inb && DEFS[t.type].ilim[m]) return Math.max(0, DEFS[t.type].ilim[m] - (t.inb[m] || 0));
  return 0;
}
function bulkMove(s, t, m, mv) {
  const g = GRADED.has(m) ? gradeOf(s, ...outFields(s)) : null;
  if (s.type === 'hopper' || s.type === 'bin') { s.stock -= mv; if (s.type === 'bin' && s.stock < 1e-6) { s.stock = 0; s.mat = null; } }
  else s.outb[m] -= mv;
  if (t.type === 'bin' || t.type === 'hopper') { if (g) blendG(t, 'ga', 'gs', t.stock, mv, g); t.stock += mv; t.mat = m; }
  else { if (g) blendG(t, 'ga', 'gs', t.inb[m] || 0, mv, g); t.inb[m] = (t.inb[m] || 0) + mv; }
}
function updFeeder(f) {
  const s = get(f.x - DX[f.dir], f.y - DY[f.dir]), t = get(f.x + DX[f.dir], f.y + DY[f.dir]);
  f.flow = 0;
  if (!s || !t || s === t) { f.status = 'Not connected'; return; }
  const [m, av] = bulkAvail(s);
  if (!m || av <= 1e-9) { f.status = 'Starved'; return; }
  const room = bulkRoom(t, m);
  if (room <= 1e-9) { f.status = bulkRoom(t, m) === 0 && !(t.inb && DEFS[t.type].ilim[m]) && t.type !== 'bin' && t.type !== 'hopper' ? `${DEFS[t.type].n} doesn't take ${ITEMS[m].n}` : 'Downstream full'; return; }
  const mv = Math.min(FEEDER_RATE * DT, av, room);
  bulkMove(s, t, m, mv); f.flow = mv; f.anim += 1; f.status = `Feeding ${ITEMS[m].n}`;
}

// =====================================================================
//  roads, trucks, signals
// =====================================================================
function roadNbrs(i) { const x = i % W, y = (i / W) | 0; let n = 0; for (let d = 0; d < 4; d++) { const nx = x + DX[d], ny = y + DY[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && isRoadI(nx + ny * W)) n++; } return n; }
const isJunction = i => isRoadI(i) && roadNbrs(i) >= 3;
function dirBetween(a, b) { const d = b - a; return d === -W ? 0 : d === 1 ? 1 : d === W ? 2 : 3; }
function sideTiles(e, side) {
  const [fw, fh] = fp(e.type, e.dir), out = [];
  if (side === 0) for (let i = 0; i < fw; i++) out.push([e.x + i, e.y - 1]);
  if (side === 2) for (let i = 0; i < fw; i++) out.push([e.x + i, e.y + fh]);
  if (side === 3) for (let j = 0; j < fh; j++) out.push([e.x - 1, e.y + j]);
  if (side === 1) for (let j = 0; j < fh; j++) out.push([e.x + fw, e.y + j]);
  return out;
}
function bays(e) {
  let t = [];
  if (e.type === 'excavator') t = [[e.x + 1 + DX[e.dir] * 2, e.y + 1 + DY[e.dir] * 2]];
  else if (e.type === 'hopper' || e.type === 'bin') t = sideTiles(e, e.dir);
  else for (let s = 0; s < 4; s++) t.push(...sideTiles(e, s));
  return t.filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H && isRoadI(x + y * W)).map(([x, y]) => x + y * W);
}
const bfsPrev = new Int32Array(W * H), bfsSeen = new Int32Array(W * H); let bfsGen = 0;
function bfs(start, goals, wantPath) {
  const g = ++bfsGen, prev = bfsPrev; bfsSeen[start] = g; prev[start] = -1;
  const q = [start]; let h = 0;
  const gs = goals ? new Set(goals) : null;
  while (h < q.length) {
    const i = q[h++];
    if (gs && gs.has(i)) {
      if (!wantPath) return { dist: pathLen(prev, i) };
      const path = []; for (let c = i; c !== start; c = prev[c]) path.push(c); path.reverse(); return { path, dist: path.length };
    }
    const x = i % W, y = (i / W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d]; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = nx + ny * W; if (bfsSeen[j] === g || !isRoadI(j)) continue;
      bfsSeen[j] = g; prev[j] = i; q.push(j);
    }
  }
  return null;
}
function pathLen(prev, i) { let n = 0; while (prev[i] >= 0) { i = prev[i]; n++; } return n; }

function srcMat(s) {
  if (s.dead) return null;
  if (s.type === 'excavator') return s.mat;   // stockpile first, else the face
  if (s.type === 'bin') return s.stock >= 10 ? s.mat : null;
  if (s.type === 'depot') return BULK.has(s.sel) && s.stock >= 10 ? s.sel : null;
  return null;
}
function sinkRoom(k, m) {
  if (k.dead) return 0;
  if (k.type === 'hopper') return k.mat === m ? BIN_CAP - k.stock - k.incoming : 0;
  if (k.type === 'residue') return m === 'redmud' ? RESIDUE_CAP - k.fill - k.incoming : 0;
  if (k.type === 'crusher') return CRUSHED[m] && (k.mat === m || k.stock < 1) ? ROM_PAD - k.stock - k.incoming : 0;
  return 0;
}
const SINK_PRI = { hopper: 0, crusher: 0, residue: 1 };
const isSink = k => k.type === 'hopper' || k.type === 'residue' || k.type === 'crusher';
// tip into a sink; returns tonnes moved
function tipInto(k, t, rate) {
  const m = t.mat;
  const room = k.type === 'hopper' ? (k.mat === m ? BIN_CAP - k.stock : 0) : k.type === 'residue' ? (m === 'redmud' ? RESIDUE_CAP - k.fill : 0)
    : k.type === 'crusher' ? (CRUSHED[m] && (k.mat === m || k.stock < 1) ? ROM_PAD - k.stock : 0) : 0;
  const mv = Math.min(rate * DT, t.load, room);
  if (mv <= 1e-9) return 0;
  const g = GRADED.has(m) ? gradeOf(t) : null;
  if (k.type === 'hopper' || k.type === 'crusher') { if (g) blendG(k, 'ga', 'gs', k.stock, mv, g); k.stock += mv; k.mat = m; }
  else { k.fill += mv; stats.mud += mv; }
  t.load -= mv; stats.hauled += mv;
  return mv;
}
function loadFrom(t, m, mv, g) {   // put mv tonnes of m (grade g) on a truck
  if (GRADED.has(m) && g) blendG(t, 'ga', 'gs', t.load, mv, g);
  t.load += mv; t.mat = m;
}
function assignJob(t) {
  let best = null, bs = 1e18;
  const sinks = ents.filter(isSink);
  if (t.load > 0 && t.mat) {   // still carrying something: find somewhere to tip it
    for (const k of sinks) {
      if (sinkRoom(k, t.mat) < Math.min(t.load, capOf(t.mat) * .3)) continue;
      const kb = bays(k); if (!kb.length) continue;
      const r = bfs(t.tile, kb, false); if (!r) continue;
      const sc = SINK_PRI[k.type] * 1e6 + r.dist;
      if (sc < bs) { bs = sc; best = k; }
    }
    if (best) {
      t.job = { src: best, sink: best, m: t.mat }; t.state = 'toSink'; t.path = []; t.parked = false; t.idleT = 0; t.stuck = 0;
      if (best.incoming !== undefined) best.incoming += TRUCK_CAP;
    }
    return;
  }
  for (const s of ents) {
    const m = s.type === 'excavator' || s.type === 'bin' || s.type === 'depot' ? srcMat(s) : null;
    if (!m) continue;
    const sb = bays(s); if (!sb.length) continue;
    const assigned = trucks.filter(o => !o.man && o.job && o.job.src === s).length;
    if (s.type === 'excavator' && assigned >= 3) continue;
    if ((s.type === 'bin' || s.type === 'depot') && s.stock < assigned * TRUCK_CAP * .6 + 10) continue;
    const r1 = bfs(t.tile, sb, false); if (!r1) continue;
    let bk = null, bkScore = 1e18;
    for (const k of sinks) {
      if (sinkRoom(k, m) < capOf(m) * .3) continue;
      const kb = bays(k); if (!kb.length) continue;
      const r2 = bfs(sb[0], kb, false); if (!r2) continue;
      const sc = SINK_PRI[k.type] * 1e6 + r2.dist;
      if (sc < bkScore) { bkScore = sc; bk = { k, d: r2.dist, pri: SINK_PRI[k.type] }; }
    }
    if (!bk) continue;
    const score = bk.pri * 1e6 + r1.dist + bk.d + assigned * 25;
    if (score < bs) { bs = score; best = { src: s, sink: bk.k, m }; }
  }
  if (best) {
    t.job = best; t.state = 'toSrc'; t.path = []; t.parked = false; t.idleT = 0; t.stuck = 0;
    if (best.sink.incoming !== undefined) best.sink.incoming += TRUCK_CAP;
  }
}
function endJob(t) {
  if (t.job && t.job.sink.incoming !== undefined && !t.job.sink.dead) t.job.sink.incoming = Math.max(0, t.job.sink.incoming - TRUCK_CAP);
  t.job = null; t.state = 'idle'; t.path = []; t.wait = 0;
}
let occ = new Map();
function occAdd(i, t, h) { let a = occ.get(i); if (!a) occ.set(i, a = []); a.push([t, h]); }
function laneFree(t, i, h) {
  const a = occ.get(i); if (!a) return true;
  const j = isJunction(i);
  for (const [o, oh] of a) { if (o === t) continue; if (j || oh === h) return false; }
  return true;
}
function canEnter(t, j, h) {
  if (!isRoadI(j) || creep[j] || !laneFree(t, j, h)) return false;
  const r = cells[j];
  if (r.sig) { if (r.sig.amber > 0 || r.sig.allred > 0 || r.sig.green !== h % 2) return false; }
  if (isJunction(j) && t.path.length > 1) { const k = t.path[1]; if (!laneFree(t, k, dirBetween(j, k))) return false; }
  return true;
}
function updSignal(r) {
  const s = r.sig, idx = r.x + r.y * W, dem = [false, false];
  for (const t of trucks) if (t.next < 0 && t.path.length && t.path[0] === idx && t.tile !== idx) dem[dirBetween(t.tile, idx) % 2] = true;
  s.dem = dem; s.t++;
  if (!isJunction(idx)) { r.sig = null; return; }
  if (s.amber > 0) { if (--s.amber === 0) { s.allred = 30; } return; }
  if (s.allred > 0) { if (--s.allred === 0) { s.green = 1 - s.green; s.t = 0; } return; }
  const other = 1 - s.green;
  if (dem[other] && ((!dem[s.green] && s.t > 90) || s.t > 480)) s.amber = 60;
}
// Haul physics. Rimpull limits a loaded truck on a ramp; retarders cap it downhill. Ruts slow everyone.
function gradeBetween(a, b) { const g = (elevAt(b) - elevAt(a)) / TILE_M; return g > .3 ? .3 : g < -.3 ? -.3 : g; }
function speedFor(loaded, g, wear) {
  let v = loaded ? 3.5 : 5;
  if (g > 0) v *= Math.max(loaded ? .28 : .45, 1 - g * (loaded ? 7 : 3));
  else v *= Math.min(loaded ? 1.2 : 1.12, 1 - g * (loaded ? 2 : 1.2));
  return v * (1 - .45 * wear) / 60;
}
function fuelFor(loaded, g, wear) {
  const base = DIESEL_TILE[loaded ? 1 : 0];
  return base * (g > 0 ? 1 + g * (loaded ? 9 : 4) : Math.max(.35, 1 + g * 3)) * (1 + .6 * wear);
}
const wearRoad = (j, loaded) => { const r = cells[j]; if (r && r.type === 'road') r.wear = Math.min(1, (r.wear || 0) + (loaded ? .01 : .003)); };
function truckSpeed(t) { return t.sp || (t.load > 0 ? 3.5 : 5) / 60; }
function moveTruck(t) {
  if (t.next >= 0) {
    t.p += truckSpeed(t);
    if (t.p >= 1) { t.prevTile = t.tile; t.tile = t.next; t.next = -1; t.p = 0; t.path.shift(); }
    return;
  }
  if (!t.path.length) return;
  const j = t.path[0];
  if (!isRoadI(j)) { t.path = []; return; }
  const h = dirBetween(t.tile, j);
  if (!canEnter(t, j, h)) { t.wait++; t.status = 'Waiting in traffic'; return; }
  t.next = j; t.h = h; t.p = 0; t.wait = 0; occAdd(j, t, h);
  const g = gradeBetween(t.tile, j), w = cells[j].wear || 0, ld = t.load > 0;
  t.g = g; t.sp = speedFor(ld, g, w);
  burnDiesel(fuelFor(ld, g, w)); wearRoad(j, ld);
}
function updTruck(t) {
  const job = t.job;
  if (job && (job.src.dead || job.sink.dead)) endJob(t);
  if (!isRoadI(t.tile)) { t.state = 'idle'; t.path = []; }
  switch (t.state) {
    case 'idle':
      t.status = t.load > 0 ? 'Holding ' + Math.round(t.load) + ' t — nowhere to tip' : 'Idle — no haul job';
      if ((tick + t.id * 7) % 45 === 0 && t.next < 0) assignJob(t);
      if (!t.job && t.next < 0 && ++t.idleT > 90) t.parked = true;
      break;
    case 'toSrc': case 'toSink': {
      const goal = t.state === 'toSrc' ? t.job.src : t.job.sink;
      if (t.next < 0 && !t.path.length) {
        const gb = bays(goal);
        if (gb.includes(t.tile)) { t.state = t.state === 'toSrc' ? 'loading' : 'dumping'; t.wait = 0; break; }
        const r = bfs(t.tile, gb, true);
        if (r && r.path.length) { t.path = r.path; t.stuck = 0; }
        else if (++t.stuck > 8) { t.status = 'No route'; endJob(t); break; }
      }
      t.status = t.state === 'toSrc' ? `→ ${DEFS[goal.type].n} (empty)` : `→ ${DEFS[goal.type].n} (${Math.round(t.load)} t ${ITEMS[t.mat].n})`;
      break;
    }
    case 'loading': {
      const s = job.src;
      if (s.type === 'excavator') {
        t.status = s.status === 'Loading truck' ? 'Being loaded' : 'Waiting at shovel';
        if (t.load >= capOf(t.mat) - 1e-6 || (!s.mat && t.load > 0) || t.full) { t.full = false; t.state = 'toSink'; t.path = []; }
        else if (!s.mat && t.load <= 0) endJob(t);
      } else {
        const m = job.m;
        const av = s.type === 'bin' ? (s.mat === m ? s.stock : 0) : (s.sel === m ? s.stock : 0);
        const mv = Math.min(10 * DT, av, capOf(m) - t.load);
        if (mv > 1e-9) {
          const g = gradeOf(s);
          s.stock -= mv; if (s.stock < 1e-6) { s.stock = 0; if (s.type === 'bin') s.mat = null; }
          loadFrom(t, m, mv, g); t.wait = 0; t.status = 'Loading';
        } else { t.wait++; t.status = 'Waiting for material'; }
        if (t.load >= capOf(m) - 1e-6 || (t.wait > 180 && t.load >= capOf(m) * .3)) { t.state = 'toSink'; t.path = []; }
        else if (t.wait > 600 && t.load < 1e-6) endJob(t);
      }
      break;
    }
    case 'dumping': {
      const k = job.sink;
      const mv = tipInto(k, t, 20);
      if (mv > 1e-9) {
        t.tip = Math.min(1, (t.tip || 0) + .05); t.status = 'Tipping';
      } else { t.wait++; t.status = 'Waiting to tip (full)'; if (t.wait > 900) endJob(t); }
      if (t.load <= 1e-6) { t.load = 0; t.mat = null; endJob(t); }
      break;
    }
  }
  if (t.state !== 'dumping') t.tip = Math.max(0, (t.tip || 0) - .04);
  moveTruck(t);
}
function spawnTruck(x, y, pid) {
  const i = x + y * W;
  if (!isRoadI(i)) return null;
  if (trucks.some(t => t.tile === i || t.next === i)) return null;
  if (!canAfford(costOf('truck'))) { hooks.onEvent('nomats', { pid, type: 'truck', short: shortOf(costOf('truck')) }); return null; }
  pay(costOf('truck'));
  const t = { id: nextTruck++, tile: i, prevTile: i, h: 1, next: -1, p: 0, path: [], load: 0, mat: null, state: 'idle', job: null, wait: 0, idleT: 0, parked: false, stuck: 0, tip: 0, status: 'Idle', full: false };
  trucks.push(t);
  return t;
}
function removeTruck(id) {
  const k = trucks.findIndex(t => t.id === id); if (k < 0) return;
  endJob(trucks[k]); trucks.splice(k, 1); refund(costOf('truck'), 1);
}
function toggleSignal(x, y, pid) {
  const r = get(x, y); if (!r || r.type !== 'road') return;
  if (r.sig) { r.sig = null; refund(costOf('signal'), 1); return; }
  if (!isJunction(x + y * W)) { hooks.onEvent('notjunction', { pid }); return; }
  if (!canAfford(costOf('signal'))) { hooks.onEvent('nomats', { pid, type: 'signal', short: shortOf(costOf('signal')) }); return; }
  pay(costOf('signal'));
  r.sig = { green: 0, t: 0, amber: 0, allred: 0, dem: [false, false] };
}

// =====================================================================
//  manual driving (trucks drive freely in continuous space; excavators crawl tile by tile)
// =====================================================================
// Heading is a unit vector rotated with small-angle steps and renormalised with sqrt: no trig, so it is
// bit-identical in every JS engine.
const DRV_MAX = 7 / 60, DRV_REV = 2.5 / 60, DRV_ACC = .0035, DRV_BRAKE = .01, DRV_DRAG = .0015, DRV_TURN = .032, EXC_CRAWL = .7 / 60;
const truckOf = pid => trucks.find(t => t.drv === pid);
const excOf = pid => ents.find(e => e.drv === pid);
function driveBlocked(t, x, y) {
  for (const k of [.75, 0, -.75]) {
    const px = x + t.hx * k, py = y + t.hy * k, tx = Math.floor(px), ty = Math.floor(py);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return true;
    const i = tx + ty * W;
    if (water[i] || creep[i]) return true;
    const e = cells[i]; if (e && e.type !== 'road') return true;
  }
  for (const o of trucks) {
    if (o === t) continue;
    const ox = o.man ? o.mx : o.tile % W + .5, oy = o.man ? o.my : (o.tile / W | 0) + .5;
    if ((ox - x) * (ox - x) + (oy - y) * (oy - y) < 1.2 && (ox - t.mx) * (ox - t.mx) + (oy - t.my) * (oy - t.my) >= (ox - x) * (ox - x) + (oy - y) * (oy - y)) return true;
  }
  return false;
}
function enterTruck(pid, t) {
  if (!t || t.drv || truckOf(pid) || excOf(pid)) return;
  if (!t.man) {
    endJob(t);
    let x = t.tile % W + .5, y = (t.tile / W | 0) + .5;
    if (t.next >= 0) { x += (t.next % W + .5 - x) * t.p; y += ((t.next / W | 0) + .5 - y) * t.p; }
    t.man = true; t.mx = x; t.my = y; t.hx = DX[t.h]; t.hy = DY[t.h]; t.v = 0; t.next = -1; t.p = 0; t.path = []; t.parked = false;
  }
  t.drv = pid; t.th = 0; t.st = 0; t.act = false; t.status = 'Driven by hand';
}
function exitVehicle(pid) {
  const t = truckOf(pid);
  if (t) {
    t.drv = 0; t.th = 0; t.st = 0; t.act = false;
    const tx = Math.floor(t.mx), ty = Math.floor(t.my), i = tx + ty * W;
    // back on a road with the lane free: hand it back to the dispatcher
    if (isRoadI(i) && !trucks.some(o => o !== t && !o.man && (o.tile === i || o.next === i))) {
      const h = Math.abs(t.hx) > Math.abs(t.hy) ? (t.hx > 0 ? 1 : 3) : (t.hy > 0 ? 2 : 0);
      t.man = false; t.tile = i; t.prevTile = i; t.h = h; t.next = -1; t.p = 0; t.path = []; t.state = 'idle'; t.idleT = 0;
      delete t.mx; delete t.my; delete t.hx; delete t.hy; delete t.v;
    } else t.status = 'Parked off-road (drive it back onto a road)';
  }
  const e = excOf(pid); if (e) { e.drv = 0; e.th = 0; e.st = 0; }
}
function nearRect(x, y, e, r) {
  const [fw, fh] = fp(e.type, e.dir), nx = Math.max(e.x, Math.min(e.x + fw, x)), ny = Math.max(e.y, Math.min(e.y + fh, y));
  return (nx - x) * (nx - x) + (ny - y) * (ny - y) <= r * r;
}
function updManual(t) {
  const here = Math.floor(t.mx) + Math.floor(t.my) * W, onRoad = isRoadI(here);
  const ax = Math.floor(t.mx + t.hx), ay = Math.floor(t.my + t.hy), ahead = ax >= 0 && ay >= 0 && ax < W && ay < H ? ax + ay * W : here;
  const g = gradeBetween(here, ahead) * (t.v < 0 ? -1 : 1), wear = onRoad ? cells[here].wear || 0 : 0;
  const vmax = DRV_MAX * (onRoad ? 1 : .6) * (t.load > 0 ? .8 : 1) * speedFor(t.load > 0, g, wear) / speedFor(t.load > 0, 0, 0);
  const th = t.drv ? t.th : 0;
  if (th > 0) t.v = t.v < 0 ? Math.min(0, t.v + DRV_BRAKE) : Math.min(vmax, t.v + DRV_ACC);
  else if (th < 0) t.v = t.v > 0 ? Math.max(0, t.v - DRV_BRAKE) : Math.max(-DRV_REV, t.v - DRV_ACC * .6);
  else t.v = t.v > 0 ? Math.max(0, t.v - DRV_DRAG) : Math.min(0, t.v + DRV_DRAG);
  if (t.v > vmax) t.v = Math.max(vmax, t.v - DRV_BRAKE);
  if (t.st && t.v !== 0) {
    const a = t.st * DRV_TURN * Math.min(1, Math.abs(t.v) / .04) * (t.v > 0 ? 1 : -1);
    const hx = t.hx - a * t.hy, hy = t.hy + a * t.hx, l = Math.sqrt(hx * hx + hy * hy);
    t.hx = hx / l; t.hy = hy / l;
  }
  if (t.v !== 0) {
    const nx = t.mx + t.hx * t.v, ny = t.my + t.hy * t.v;
    if (driveBlocked(t, nx, ny)) t.v = 0;
    else { t.mx = nx; t.my = ny; burnDiesel(fuelFor(t.load > 0, g, wear) * Math.abs(t.v)); const nt = Math.floor(nx) + Math.floor(ny) * W; if (nt !== here && isRoadI(nt)) wearRoad(nt, t.load > 0); }
  }
  t.tile = Math.floor(t.mx) + Math.floor(t.my) * W; t.h = Math.abs(t.hx) > Math.abs(t.hy) ? (t.hx > 0 ? 1 : 3) : (t.hy > 0 ? 2 : 0);
  t.tipping = false;
  if (t.act && Math.abs(t.v) < .01) {
    if (t.load > 0) {   // tip into a hopper / residue area beside the truck
      const k = ents.find(k => isSink(k) && nearRect(t.mx, t.my, k, 1.7) && sinkRoom(k, t.mat) + (k.incoming || 0) > 1e-6);
      if (!k) { t.status = 'Nothing here takes ' + ITEMS[t.mat].n; t.act = false; }
      else {
        const mv = tipInto(k, t, 20);
        if (mv <= 1e-9) { t.status = DEFS[k.type].n + ' full'; t.act = false; }
        else {
          t.tipping = true; t.status = 'Tipping';
          if (t.load <= 1e-6) { t.load = 0; t.mat = null; t.act = false; t.status = 'Empty'; }
        }
      }
    } else {   // load from a bin or depot stockpile beside the truck
      const s2 = ents.find(s2 => (s2.type === 'bin' || (s2.type === 'depot' && BULK.has(s2.sel))) && nearRect(t.mx, t.my, s2, 1.7) && s2.stock >= 1);
      if (!s2) { t.act = false; t.status = ents.some(x => x.type === 'excavator' && nearRect(t.mx, t.my, x, EXC_SIDE)) ? 'At the shovel — stay stopped and it loads you' : 'Nothing to load here (stop beside an excavator, bin or depot)'; }
      else {
        const m = s2.type === 'bin' ? s2.mat : s2.sel;
        if (t.load > 0 && t.mat !== m) { t.status = 'Truck carries a different load'; t.act = false; }
        else {
          const mv = Math.min(10 * DT, s2.stock, capOf(m) - t.load), g = gradeOf(s2);
          s2.stock -= mv; if (s2.stock < 1e-6) { s2.stock = 0; if (s2.type === 'bin') s2.mat = null; }
          loadFrom(t, m, mv, g); t.status = 'Loading';
          if (t.load >= capOf(m) - 1e-6 || s2.stock <= 0) t.act = false;
        }
      }
    }
  } else if (t.act && Math.abs(t.v) >= .01) t.act = false;
  t.tip = t.tipping ? Math.min(1, (t.tip || 0) + .05) : Math.max(0, (t.tip || 0) - .04);
  if (t.shovel > 0) t.shovel--;
  if (t.shovel > 0 && !t.tipping) t.status = `Being loaded by shovel · ${Math.round(t.load)} / ${Math.round(capOf(t.mat || 'rom'))} t`;
  else if (!t.act && !t.tipping && t.drv) t.status = t.load > 0 ? `Hand-driven · ${Math.round(t.load)} t ${ITEMS[t.mat].n}` : 'Hand-driven · empty';
}
function releaseAll() { for (const t of trucks) if (t.drv) exitVehicle(t.drv); for (const e of ents) if (e.drv) exitVehicle(e.drv); }

// =====================================================================
//  excavator
// =====================================================================
// Benching: inside a pit the shovel takes the shallowest bench everywhere before cutting the next one down,
// and prefers broken (blasted or soft) ground to solid rock.
const inPitReach = (tiles) => tiles.some(i => pit[i] && isOre(i) && !cells[i]);
function pickDig(e) {
  let best = -1, bd = 1e18; const cx = e.x + 1, cy = e.y + 1, tiles = excTiles(e.x, e.y), pitOnly = inPitReach(tiles);
  for (const i of tiles) {
    if (!isOre(i) || cells[i] || (pitOnly && !pit[i])) continue;
    const dx = i % W - cx, dy = ((i / W) | 0) - cy;
    const d = (pitOnly ? benchOf(i) * 1000 : 0) + (ob[i] <= 0 && needsBlast(i) ? 400 : 0) + dx * dx + dy * dy + (dx * DX[e.dir] + dy * DY[e.dir] > 0 ? 6 : 0);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
// one bucket of broken ground from tile i, tonnes (bucket volume x fill factor x loose density)
function bucketT(i) {
  const m = oreType[i], fill = needsBlast(i) ? (hard[i] === 2 ? .3 : .55) : .9;
  return Math.max(1, Math.round(BUCKET_M3 * fill * (DENS[m] || 1.4)));
}
const cycleOf = i => Math.round(EXC_CYCLE * (needsBlast(i) ? (hard[i] === 2 ? 2.2 : 1.4) : 1));
// advance the bucket cycle; returns true on the tick the bucket dumps
function cycleStep(e, len, job) {
  if (e.job !== job) { e.job = job; e.cyc = 0; }
  e.cyc += 1 / len; e.anim++; burnDiesel(DIESEL_EXC * DT);
  if (e.cyc >= .62 && !e.dumped) { e.dumped = true; return true; }
  if (e.cyc >= 1) { e.cyc = 0; e.dumped = false; }
  return false;
}
function takeOre(e, i, n) {   // remove n t from the face; returns tonnes actually taken
  const k = Math.min(n, oreAmt[i]);
  const b0 = benchOf(i);
  oreAmt[i] -= k; madeAdd(oreType[i], k);
  if (oreAmt[i] <= 0) { oreType[i] = null; frag[i] = 0; hooks.onDeplete(i); e.dig = -1; }
  else if (benchOf(i) !== b0) { hooks.onDig(i); e.dig = -1; }   // bench finished here: move along the face
  return k;
}
// Tracked driving: continuous position and heading (unit vector, rotated without trig so it is deterministic).
// The machine occupies the 3x3 tiles under its centre; it counter-rotates its tracks, so it can turn on the spot.
const EXC_VMAX = 1.3 / 60, EXC_REV = .8 / 60, EXC_ACC = .0011, EXC_TURN = .016;
function excInit(e) { if (e.fx === undefined) { e.fx = e.x + 1.5; e.fy = e.y + 1.5; e.hx = DX[e.dir]; e.hy = DY[e.dir]; e.v = 0; } }
function excFree(e, ax, ay) {
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const cx = ax + i, cy = ay + j;
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
    const k = cx + cy * W;
    if (water[k] || creep[k]) return false;
    const o = cells[k]; if (o && o !== e) return false;
    for (const t of trucks) if (t.tile === k) return false;
  }
  return true;
}
const excBay = e => { excInit(e); return [e.fx + e.hx * 2, e.fy + e.hy * 2]; };
function updExcDrive(e) {
  excInit(e);
  const th = e.drv ? e.th | 0 : 0, st = e.drv ? e.st | 0 : 0;
  if (th > 0) e.v = Math.min(EXC_VMAX, e.v + EXC_ACC);
  else if (th < 0) e.v = Math.max(-EXC_REV, e.v - EXC_ACC);
  else e.v = e.v > 0 ? Math.max(0, e.v - EXC_ACC * 2) : Math.min(0, e.v + EXC_ACC * 2);
  if (st) {
    const a = st * EXC_TURN * (e.v < 0 ? -1 : 1), hx = e.hx - a * e.hy, hy = e.hy + a * e.hx, l = Math.sqrt(hx * hx + hy * hy);
    e.hx = hx / l; e.hy = hy / l;
    const d = Math.abs(e.hx) > Math.abs(e.hy) ? (e.hx > 0 ? 1 : 3) : (e.hy > 0 ? 2 : 0);
    if (d !== e.dir) { e.dir = d; computePorts(e); e.dig = -1; }
  }
  if (e.v !== 0) {
    const nx = e.fx + e.hx * e.v, ny = e.fy + e.hy * e.v, ax = Math.round(nx - 1.5), ay = Math.round(ny - 1.5);
    if (ax !== e.x || ay !== e.y) {
      if (!excFree(e, ax, ay)) { e.v = 0; e.status = 'Blocked'; return true; }
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) cells[e.x + i + (e.y + j) * W] = null;
      e.x = ax; e.y = ay; e.dig = -1;
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) cells[e.x + i + (e.y + j) * W] = e;
    }
    e.fx = nx; e.fy = ny;
  }
  if (e.v === 0 && !st) return false;
  e.anim++; e.target = -1; burnDiesel(DIESEL_EXC * DT * 1.5);
  e.status = e.v !== 0 ? 'Driving' : 'Turning on the spot';
  return true;
}
// where the excavator casts: stockpile ahead-left, spoil behind-right (tile units, relative to which way it faces)
function heapPos(e, which) {
  const cx = e.x + 1.5, cy = e.y + 1.5, fx = DX[e.dir], fy = DY[e.dir], lx = fy, ly = -fx;
  return which === 'pile' ? [cx + lx * 2.3 + fx * .7, cy + ly * 2.3 + fy * .7] : [cx - lx * 2.4 - fx * 1.2, cy - ly * 2.4 - fy * 1.2];
}
const HEAP_MERGE = 1.5, HEAP_REACH = 3.2;
function heapNear(x, y, spoil) {   // the heap of that kind within merging distance of (x, y)
  let best = null, bd = HEAP_MERGE * HEAP_MERGE;
  for (const h of heaps) if ((h.m === 'spoil') === spoil) { const d = (h.x - x) * (h.x - x) + (h.y - y) * (h.y - y); if (d < bd) { bd = d; best = h; } }
  return best;
}
function castHeap(e, which, m) {   // the heap this excavator casts onto now, created on first bucket
  const [x, y] = heapPos(e, which);
  return heapNear(x, y, which === 'spoil') || (m ? (heaps.push({ x, y, m, t: 0 }), heaps[heaps.length - 1]) : null);
}
function oreHeapFor(e) {   // an ore stockpile within the bucket's reach: the one at its casting spot first
  const [x, y] = heapPos(e, 'pile'), own = heapNear(x, y, false);
  if (own && own.t >= 1) return own;
  return heaps.find(h => h.m !== 'spoil' && h.t >= 1 && nearRect(h.x, h.y, e, HEAP_REACH)) || own;
}
function dropEmptyHeaps() { for (let k = heaps.length - 1; k >= 0; k--) if (heaps[k].t < 1e-6) heaps.splice(k, 1); }
const EXC_SIDE = 2.2;      // a hand-driven truck stopped this close to the excavator's footprint gets loaded
const EXC_PILE_CAP = 150;   // t of loose ore it will cast onto a stockpile beside itself while no truck is at the bay
function updExcavator(e) {
  if (updExcDrive(e)) return;
  if (e.pref >= 0 && e.pref !== e.dig && isOre(e.pref) && !cells[e.pref] && excTiles(e.x, e.y).includes(e.pref)) e.dig = e.pref;
  if (e.dig < 0 || !isOre(e.dig) || cells[e.dig]) e.dig = pickDig(e);
  const face = e.dig >= 0 ? ROM_OF[oreType[e.dig]] : null, hp = oreHeapFor(e), pile = hp ? hp.t : 0;
  e.pile = pile; e.pileMat = pile >= 1 ? hp.m : null;   // mirrored for the inspector
  e.mat = pile >= 1 ? e.pileMat : face;   // what the next truck will get
  const bay = bays(e)[0];
  const [bx, by] = excBay(e);
  const room = t => capOf(t.load > 0 ? t.mat : (pile >= 1 ? e.pileMat : face)) - t.load;
  const tr = trucks.find(t => t.man ? Math.abs(t.v) < .01 && ((t.mx - bx) * (t.mx - bx) + (t.my - by) * (t.my - by) < 1.69 || nearRect(t.mx, t.my, e, EXC_SIDE)) && room(t) >= 1 && !t.full && !t.tipping
    : bay !== undefined && t.tile === bay && t.next < 0 && t.state === 'loading' && t.job && t.job.src === e);
  if (!tr) e.passes = 0;
  if (tr && tr.man) tr.shovel = 90;
  // a truck at the bay: rehandle the stockpile first (broken material loads in full buckets)
  if (tr && pile >= 1) {
    if (tr.load > 0 && tr.mat !== e.pileMat) { if (!tr.man) tr.full = true; e.status = 'Truck carries a different ore'; return; }
    e.target = -2; e.status = 'Loading truck from stockpile';
    if (cycleStep(e, REHANDLE_CYCLE, 'rehandle')) {
      const r = room(tr), b = Math.round(BUCKET_M3 * .95 * (DENS[hp.m] || 1.4)), mv = Math.min(b, hp.t, r);
      loadFrom(tr, hp.m, mv, [hp.ga, hp.gs]); hp.t -= mv; e.passes++; e.pile = hp.t;
      if (hp.t < 1e-6) { dropEmptyHeaps(); e.pile = 0; e.pileMat = null; }
      if (room(tr) < b * .4 && !tr.man) tr.full = true;
    }
    return;
  }
  if (e.dig < 0) { e.status = pile >= 1 ? 'Face exhausted — stockpile waiting' : 'Face exhausted — relocate'; e.target = -1; e.job = null; return; }
  const i = e.dig;
  if (ob[i] > 0) {   // overburden: soft, cast to the spoil heap
    e.target = i; e.status = 'Stripping overburden';
    if (cycleStep(e, STRIP_CYCLE, 'strip')) {
      const mv = Math.min(ob[i], 18);
      ob[i] -= mv; const sh = castHeap(e, 'spoil', 'spoil'); sh.t += mv * 3; e.spoil = sh.t;
      if (ob[i] <= 1e-6) { ob[i] = 0; hooks.onStrip(i); e.dig = -1; }
    }
    return;
  }
  const m = face, slow = needsBlast(i);
  if (!tr) {   // no truck: dig onto the stockpile
    const ch = castHeap(e, 'pile', null), cp = ch ? ch.t : 0;
    if (cp >= EXC_PILE_CAP - 1e-6) { e.status = bay === undefined ? 'Stockpile full — no road at bay' : 'Stockpile full — waiting for truck'; e.target = -1; e.job = null; return; }
    if (cp >= 1 && ch.m !== m) { e.status = 'Stockpile holds a different ore'; e.target = -1; e.job = null; return; }
    e.target = i; e.status = slow ? 'Digging unblasted rock (slow)' : 'Digging to stockpile';
    if (cycleStep(e, cycleOf(i), 'pile')) {
      const g = [gA[i], gS[i]], k = takeOre(e, i, Math.min(bucketT(i), Math.ceil(EXC_PILE_CAP - cp)));
      if (k > 0) { const h = castHeap(e, 'pile', m); h.m = m; blendG(h, 'ga', 'gs', h.t, k, g); h.t += k; }
    }
    return;
  }
  if (tr.load > 0 && tr.mat !== m) { if (!tr.man) tr.full = true; e.status = 'Truck carries a different ore'; return; }
  e.target = i; e.status = slow ? 'Loading truck (unblasted rock, slow)' : 'Loading truck';
  if (cycleStep(e, cycleOf(i), 'load')) {
    const g = [gA[i], gS[i]], b = bucketT(i), r = room(tr);
    const k = takeOre(e, i, Math.max(0, Math.min(b, Math.floor(r))));
    if (k > 0) { loadFrom(tr, m, k, g); e.passes++; }
    if (room(tr) < b * .4 && !tr.man) tr.full = true;
  }
}

// =====================================================================
//  drill & blast, crushing, washing, tailings, road grading
// =====================================================================
function drillTargets(e) {
  const cx = e.x + 1, cy = e.y + 1, out = [];
  let pitAny = false;
  for (let j = -DRILL_R; j <= DRILL_R; j++) for (let i = -DRILL_R; i <= DRILL_R; i++) {
    const x = cx + i, y = cy + j; if (x < 0 || y < 0 || x >= W || y >= H || i * i + j * j > DRILL_R * DRILL_R) continue;
    const k = x + y * W; if (pit[k] && isOre(k)) pitAny = true;
  }
  for (let j = -DRILL_R; j <= DRILL_R; j++) for (let i = -DRILL_R; i <= DRILL_R; i++) {
    const x = cx + i, y = cy + j; if (x < 0 || y < 0 || x >= W || y >= H || i * i + j * j > DRILL_R * DRILL_R) continue;
    const k = x + y * W;
    if (needsBlast(k) && ob[k] <= 0 && !cells[k] && (!pitAny || pit[k]) && !e.holes.includes(k)) out.push(k);
  }
  out.sort((a, b) => (pitAny ? benchOf(a) - benchOf(b) : 0) || a - b);
  return out;
}
// the rig trams between holes; the 2x2 building is its explosives magazine
const RIG_V = .8 / 60;
function tram(e, x, y) {
  const dx = x - e.lx, dy = y - e.ly, d = Math.sqrt(dx * dx + dy * dy);
  if (d < .05) return true;
  const v = Math.min(d, RIG_V); e.lx += dx / d * v; e.ly += dy / d * v; e.rhx = dx / d; e.rhy = dy / d; burnDiesel(.01 * DT);
  return false;
}
const rigHome = e => [e.x + 1 + DX[e.dir] * 1.6, e.y + 1 + DY[e.dir] * 1.6];
function updDrill(e) {
  if (e.fuse > 0) {
    const [hx, hy] = rigHome(e); tram(e, hx, hy);
    e.status = 'Clear the area — firing in ' + Math.ceil(e.fuse / 60) + ' s';
    if (--e.fuse === 0) {
      for (const k of e.holes) if (isOre(k)) { frag[k] = 1; hooks.onDig(k); }
      stats.blasts = (stats.blasts || 0) + 1;
      hooks.onEvent('blast', { tiles: e.holes.slice(), x: e.x + 1, y: e.y + 1 });
      e.holes = [];
    }
    return;
  }
  e.holes = e.holes.filter(k => needsBlast(k));
  const need = Math.ceil(e.holes.length / 2);
  const tg = e.holes.length < PATTERN ? drillTargets(e) : [];
  if (e.holes.length && !tg.length && e.cur < 0) e.idle = (e.idle || 0) + 1; else e.idle = 0;
  if (e.holes.length >= PATTERN || e.idle > 1800) {   // full pattern (or nothing more to drill for 30 s): charge and fire
    const [hx, hy] = rigHome(e); tram(e, hx, hy);
    if ((e.inb.anfo || 0) < need) { e.status = `Pattern drilled (${e.holes.length} holes) — needs ${need} ANFO`; return; }
    e.inb.anfo -= need; e.fuse = FUSE; e.cur = -1; e.idle = 0; return;
  }
  if (e.cur >= 0 && !needsBlast(e.cur)) e.cur = -1;
  if (e.cur < 0) {
    if (!tg.length) { const [hx, hy] = rigHome(e); tram(e, hx, hy); e.status = e.holes.length ? `${e.holes.length} holes drilled — waiting for more stripped rock` : 'Nothing to drill (strip the overburden off hard rock in range)'; return; }
    e.cur = tg[0]; e.dprog = 0;
  }
  if (!tram(e, (e.cur % W) + .5, ((e.cur / W) | 0) + .5)) { e.status = `Tramming to hole ${e.holes.length + 1}/${PATTERN}`; return; }
  e.dprog += 1 / DRILL_T; e.anim++; burnDiesel(.012 * DT);
  e.status = `Drilling hole ${e.holes.length + 1}/${PATTERN}`;
  if (e.dprog >= 1) { e.holes.push(e.cur); e.cur = -1; e.dprog = 0; }
}
function updCrusher(e) {
  e.wants = 0; e.flow = 0;
  if (e.stock < 1e-6) { e.stock = 0; if (e.mat && !(e.outb[CRUSHED[e.mat]] > 1e-9)) e.mat = null; }
  if (!e.mat || e.stock <= 0) { e.status = 'ROM pad empty'; return; }
  const out = CRUSHED[e.mat], have = e.outb[out] || 0;
  for (const k in e.outb) if (k !== out && e.outb[k] > 1e-9) { e.status = 'Clearing ' + ITEMS[k].n; return; }
  if (have >= 20) { e.status = 'Crushed ore backing up — feeder blocked or missing'; return; }
  e.wants = DEFS.crusher.power;
  if (satO <= 0) { e.status = 'No power'; return; }
  const mv = Math.min(CRUSH_RATE * satO * DT, e.stock, 20 - have);
  if (GRADED.has(out)) blendG(e, 'oga', 'ogs', have, mv, gradeOf(e));
  e.stock -= mv; e.outb[out] = have + mv; e.flow = mv; e.anim += satO; madeAdd(out, mv); stats.crushed = (stats.crushed || 0) + mv;
  e.status = 'Crushing ' + ITEMS[e.mat].n;
}
function updWash(e) {
  portExchange(e);
  e.wants = 0;
  if (!e.wact) {
    if ((e.inb.bauxite || 0) < 4 - 1e-9) { e.status = 'Missing: crushed bauxite'; return; }
    if ((e.fin.water || 0) < 30 - 1e-9) { e.status = 'Missing: Water' + (e.ports[0].net ? '' : ' (no pipe)'); return; }
    if ((e.outb.bauxite || 0) > 6 || (e.fout.tailings || 0) > 90) { e.status = (e.fout.tailings || 0) > 90 ? 'Tailings backing up — pipe to a dam' : 'Output full'; return; }
    const [a, si] = gradeOf(e), m = .06 + .012 * si;            // fines carry clay: high silica, lower alumina
    const t = 4 * (1 - m), al = (a / 100 * 4 - m * 4 * .3) / t, sil = (si / 100 * 4 * .5) / t;
    e.inb.bauxite -= 4; e.fin.water -= 30;
    e.wact = true; e.prog = 0; e.batch = [t, Math.min(65, al * 100), Math.max(.3, sil * 100), m];
  }
  e.wants = DEFS.washplant.power;
  if (satO <= 0) { e.status = 'No power'; return; }
  e.prog += satO / 120; e.anim += satO; e.status = 'Washing';
  if (e.prog >= 1) {
    const [t, al, sil, m] = e.batch;
    blendG(e, 'oga', 'ogs', e.outb.bauxite || 0, t, [al, sil]);
    e.outb.bauxite = (e.outb.bauxite || 0) + t; e.fout.tailings = (e.fout.tailings || 0) + 24 + m * 60;
    stats.tails = (stats.tails || 0) + 4 * m;
    e.wact = false; e.prog = 0;
  }
}
function updTailings(e) {
  portExchange(e);
  const f = e.fin.tailings || 0;
  if (f > 0 && e.fill < TAIL_CAP) { const mv = Math.min(f, TAIL_CAP - e.fill); e.fill += mv; e.fin.tailings = f - mv; }
  e.status = e.fill >= TAIL_CAP ? 'Full' : f > 0 || e.fill > 0 ? 'Settling' : 'Empty';
}
function updGrader(e) {
  if (e.gt < 0 || !isRoadI(e.gt)) {
    const b = bays(e); e.path = []; e.gn = -1; e.gp = 0;
    if (!b.length) { e.gt = -1; e.status = 'Needs a road beside the shed'; return; }
    e.gt = b[0];
  }
  const cx = e.x + 1, cy = e.y + 1;
  if (e.gn >= 0) {
    e.gp += GRADER_SPEED; e.anim++;
    if (e.gp >= 1) { e.gt = e.gn; e.gn = -1; e.gp = 0; e.path.shift(); }
  }
  const r = cells[e.gt];
  if (e.gn < 0 && r && r.wear > .02 && (!e.path.length || r.wear > .08)) {   // blade down: cut the ruts out
    r.wear = Math.max(0, r.wear - .006); e.anim++; burnDiesel(.02 * DT); e.status = 'Grading road'; return;
  }
  if (e.gn < 0 && !e.path.length && (tick + e.x * 13) % 60 === 0) {
    let best = -1, bw = .12;
    for (const o of ents) if (o.type === 'road' && o.wear > bw && Math.abs(o.x - cx) + Math.abs(o.y - cy) <= GRADER_R) { bw = o.wear; best = o.x + o.y * W; }
    if (best >= 0 && best !== e.gt) { const p = bfs(e.gt, [best], true); if (p && p.path.length) e.path = p.path; }
  }
  if (e.gn < 0 && e.path.length) {
    const j = e.path[0];
    if (!isRoadI(j)) { e.path = []; return; }
    e.gh = dirBetween(e.gt, j); e.gn = j; e.gp = 0; burnDiesel(.15);
  }
  e.status = e.gn >= 0 ? 'Driving to rutted road' : 'Roads in good order';
}
function setPit(x0, y0, x1, y1, on) {
  const ax = Math.max(0, Math.min(x0, x1)), bx = Math.min(W - 1, Math.max(x0, x1)), ay = Math.max(0, Math.min(y0, y1)), by = Math.min(H - 1, Math.max(y0, y1));
  if (bx - ax > 40 || by - ay > 40) return;
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) { const i = x + y * W; if (!water[i]) pit[i] = on ? 1 : 0; }
  hooks.onPit(ax, ay, bx, by);
}

// =====================================================================
//  machines
// =====================================================================
function recipeReady(m, r) {
  for (const k in r.i || {}) if ((m.inb[k] || 0) < r.i[k] - 1e-9) return false;
  for (const k in r.fi || {}) if ((m.fin[k] || 0) < r.fi[k] - 1e-9) return false;
  return true;
}
function outputRoom(m, r) {
  const d = DEFS[m.type];
  for (const k in r.o || {}) if ((m.outb[k] || 0) + r.o[k] > d.olim[k]) return false;
  for (const k in r.fo || {}) if ((m.fout[k] || 0) + r.fo[k] > d.folim[k]) return false;
  return true;
}
function missing(m) {
  const d = DEFS[m.type], r = d.recipes[d.recipes.length - 1], miss = [];
  for (const k in r.i || {}) if ((m.inb[k] || 0) < r.i[k] - 1e-9 && !(m.type === 'paste' && k === 'coke' && (m.inb.butt || 0) >= 1 && (m.inb.coke || 0) >= 1)) miss.push(ITEMS[k].n);
  for (const k in r.fi || {}) if ((m.fin[k] || 0) < r.fi[k] - 1e-9) {
    const pt = m.ports.find(p => p.f === k && p.io === 'in');
    miss.push(FLUIDS[k].n + (!pt.net ? ' (no pipe)' : pt.net.fluid && pt.net.fluid !== k ? ' (pipe has ' + FLUIDS[pt.net.fluid].n + ')' : ''));
  }
  return miss;
}
function updMachine(m) {
  const d = DEFS[m.type];
  portExchange(m);
  m.wants = 0;
  if (!m.active) {
    const r = d.recipes.find(r => recipeReady(m, r));
    if (!r) { m.status = 'Missing: ' + missing(m).join(', '); return; }
    if (!outputRoom(m, r)) { m.status = 'Output full'; return; }
    if (m.type === 'mill') {
      const [a, si] = gradeOf(m), extra = Math.round(si * 1.6 * 10) / 10;
      if ((m.fin.liquor || 0) < r.fi.liquor + extra - 1e-9) { m.status = `Missing: Caustic liquor (silica ${si.toFixed(1)} % eats ${extra} more)`; return; }
      m.fin.liquor -= extra; stats.sodaLost = (stats.sodaLost || 0) + extra;
      m.yld = Math.round(40 * a / 47 * 10) / 10;
    }
    for (const k in r.i || {}) { m.inb[k] -= r.i[k]; if (k === 'coal') stats.co2 += r.i[k] * 2.4; if (k === 'limestone') stats.co2 += r.i[k] * .44; }
    for (const k in r.fi || {}) m.fin[k] -= r.fi[k];
    m.active = r; m.prog = 0;
  }
  if (m.fire > 0) m.fire--;
  if (m.prog < 1) {
    m.wants = d.power || 0;
    if (satO <= 0) { m.status = 'No power'; return; }
    m.prog += satO / (m.active.t * 60);
    m.anim += satO; m.status = satO < 1 ? 'Working (low power)' : 'Working';
  }
  if (m.prog >= 1) {
    const r = m.active;
    if (!outputRoom(m, r)) { m.status = 'Output full'; return; }
    if (m.type === 'teststand') m.fire = 40;
    if (m.type === 'teststand' && rand() < .04) { stats.enginefail++; hooks.onEvent('enginefail', { x: m.x, y: m.y }); }
    else for (const k in r.o || {}) { m.outb[k] = (m.outb[k] || 0) + r.o[k]; madeAdd(k, r.o[k]); }
    for (const k in r.fo || {}) { const n = m.type === 'mill' && k === 'slurry' && m.yld ? m.yld : r.fo[k]; m.fout[k] = (m.fout[k] || 0) + n; stats.fmade[k] = (stats.fmade[k] || 0) + n; }
    m.active = null; m.prog = 0;
  }
}
function updPot(e) {
  const ib = e.inb, ob_ = e.outb;
  e.feedFlash = Math.max(0, e.feedFlash - 1);
  e.al = Math.max(0, e.al);
  portExchange(e);
  if (e.frozen) { e.wants = 0; e.volt = 0; e.status = 'FROZEN'; e.T += (25 - e.T) * DT / 30; return; }
  if (e.bath < 70 && (ib.cryolite || 0) >= 1) { ib.cryolite--; e.bath = Math.min(100, e.bath + 25); }
  if (e.carbon <= 20 && (ib.anode || 0) >= 1 && (e.carbon <= 1 || (ob_.butt || 0) < 3)) {
    if (e.carbon > 1 && (ob_.butt || 0) < 3) ob_.butt = (ob_.butt || 0) + 1;
    ib.anode--; e.carbon = 100;
  }
  const molten = e.T >= 930;
  if (molten) {
    if (e.al < 3 && (e.fin.alumina || 0) >= ALUMINA_PER_FEED) { e.fin.alumina -= ALUMINA_PER_FEED; e.al += 1; e.feedFlash = 18; }
    if (e.xs < 10 && (ib.alf3 || 0) >= 1) { ib.alf3--; e.xs += 2.5; }
  }
  const cond = e.bath >= 40 && e.carbon > 0;
  e.wants = cond ? (e.ae ? 2.4 : DEFS.pot.power) : 0;
  const Teq = cond ? (satP >= .85 ? 965 - (1 - satP) * 600 : 25 + 850 * satP / .85) + (e.ae ? 60 : 0) : 25;
  e.T += (Teq - e.T) * DT / (Teq > e.T ? 10 : 60);
  if (e.T >= 950 && !e.hot) { e.hot = true; stats.potHot++; }
  if (e.hot && e.T < 880) {
    e.freezeT += DT;
    if (e.freezeT > 10) { e.frozen = true; e.ae = false; stats.frozen++; hooks.onEvent('frozen', { x: e.x, y: e.y }); return; }
  } else e.freezeT = 0;
  e.ce = Math.max(.6, Math.min(.96, .955 - Math.abs(e.xs - 11.5) * .012 - (e.bath < 60 ? .05 : 0) - (e.T > 985 ? .03 : 0)));
  e.volt = cond ? 4.15 + (e.bath < 60 ? .25 : 0) + (e.ae ? 26 : 0) + (satP < 1 ? -(1 - satP) * .8 : 0) : 0;
  if (cond && molten && !e.ae && e.metal < 4 && satP > 0) {
    const r = .1 * satP * e.ce * DT;
    e.metal += r; e.al -= r * 1.93; e.carbon -= r * 50; e.xs -= r * .8; e.bath -= DT * .015;
    stats.co2 += r * 1.6; e.anim += satP;
    if (e.al < 1) { e.ae = true; stats.ae++; }
  }
  if (e.ae) { stats.co2 += DT * 1.5; if (e.al >= 2) e.ae = false; }
  if (e.metal >= 1 && (ob_.crucible || 0) < 2) { e.metal -= 1; ob_.crucible = (ob_.crucible || 0) + 1; madeAdd('crucible'); }
  e.status = e.ae ? 'ANODE EFFECT' : !cond ? (e.bath < 40 ? 'Needs cryolite bath' : 'Needs anodes') : !molten ? (e.hot ? 'Cooling — power!' : 'Pre-heating') :
    e.metal >= 4 ? 'Metal pad full — tap!' : (e.fin.alumina || 0) < ALUMINA_PER_FEED && e.al < 2 ? 'Alumina starved' : 'Operating';
}
function updPlant(p) { portExchange(p); p.avail = (p.fuelE > 0 || (p.inb.coal || 0) >= 1) && (p.fin.water || 0) >= 1; }
function runPlant(p, load) {
  p.gen = p.avail ? DEFS.powerplant.cap * load : 0;
  const e = p.gen * DT;
  if (e > 0) {
    p.fuelE -= e;
    while (p.fuelE <= 0 && (p.inb.coal || 0) >= 1) { p.inb.coal--; p.fuelE += 60; stats.co2 += 2.4; }
    p.fin.water = Math.max(0, (p.fin.water || 0) - e * .6);
    p.anim += load;
    p.status = load > .999 ? 'Full load' : `Running ${Math.round(load * 100)}%`;
  } else p.status = !p.avail ? ((p.inb.coal || 0) < 1 && p.fuelE <= 0 ? 'No coal' : 'No cooling water') : 'Standby';
}
function updPump(p) {
  const n = p.ports[0].net;
  p.status = !n ? 'Not connected' : 'Pumping';
  if (!n) return;
  if (n.amt <= .01) { n.amt = 0; n.fluid = null; }
  if (n.fluid && n.fluid !== 'water') { p.status = 'Pipe holds ' + FLUIDS[n.fluid].n; return; }
  const mv = Math.min(60 * DT, n.cap - n.amt);
  if (mv > 0) { n.fluid = 'water'; n.amt += mv; p.anim++; } else p.status = 'Pipe full';
}
let depotShare = {};
function updDepot(d) {
  const m = d.sel, rate = ALLOC[m] / 3600 / (depotShare[m] || 1);   // one allocation per item, shared by every depot requesting it
  if (BULK.has(m)) {
    for (const k in d.outb) d.outb[k] = 0;
    if (d.mat !== m) { d.mat = m; d.stock = 0; }
    if (d.stock < BIN_CAP) { d.stock = Math.min(BIN_CAP, d.stock + rate); d.status = 'Receiving allocation'; } else d.status = 'Stockpile full — waiting for trucks';
    return;
  }
  d.stock = 0; d.mat = null;
  for (const k in d.outb) if (k !== m) d.outb[k] = 0;
  const have = d.outb[m] || 0;
  if (have < 3) { d.acc += rate; if (d.acc >= 1) { d.acc -= 1; d.outb[m] = have + 1; } d.status = 'Receiving allocation'; }
  else d.status = 'Bay full — unload with inserters';
}
function handPos(e) {
  const cx = e.x * T + 16, cy = e.y * T + 16;
  const th = Math.atan2(-DY[e.dir], -DX[e.dir]) + e.a * Math.PI, L = 31 - Math.sin(e.a * Math.PI) * 9;
  return [cx + Math.cos(th) * L, cy + Math.sin(th) * L];   // render-only coordinates
}
function updInserter(e) {
  const src = get(e.x - DX[e.dir], e.y - DY[e.dir]), dst = get(e.x + DX[e.dir], e.y + DY[e.dir]);
  if (!e.hand) {
    if (e.a > 0) { e.a = Math.max(0, e.a - INS_STEP); return; }
    if (dst && src && dst !== src) e.hand = take(src, it => accepts(dst, it));
  } else {
    if (e.a < 1) { e.a = Math.min(1, e.a + INS_STEP); return; }
    if (give(dst, e.hand, 0, 0)) e.hand = null;
  }
}

// =====================================================================
//  oil, launch pad, rockets
// =====================================================================
function updWell(e) {
  const n = e.ports[0].net;
  e.wants = 0;
  const tiles = []; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const k = e.x + i + (e.y + j) * W; if (oreType[k] === 'oil' && oreAmt[k] > 0) tiles.push(k); }
  if (!tiles.length) { e.status = 'Reservoir depleted'; return; }
  if (!n) { e.status = 'Not connected'; return; }
  if (n.amt <= .01) { n.amt = 0; n.fluid = null; }
  if (n.fluid && n.fluid !== 'crude') { e.status = 'Pipe holds ' + FLUIDS[n.fluid].n; return; }
  e.wants = DEFS.oilwell.power;
  if (satO <= 0) { e.status = 'No power'; return; }
  const mv = Math.min(WELL_RATE * satO * DT, n.cap - n.amt);
  if (mv <= 0) { e.status = 'Pipe full'; return; }
  n.fluid = 'crude'; n.amt += mv; e.anim += satO; stats.crude += mv;
  e.acc = (e.acc || 0) + mv;
  while (e.acc >= 1) { e.acc -= 1; const k = tiles[(tick + e.acc * 7 | 0) % tiles.length]; if (--oreAmt[k] <= 0) { oreType[k] = null; hooks.onDeplete(k); break; } }
  e.status = 'Pumping';
}
const padReady = p => p.rocket && (p.fin.rp1 || 0) >= PAD_RP1 - 1e-6 && (p.fin.lox || 0) >= PAD_LOX - 1e-6;
function updPad(p) {
  portExchange(p);
  p.wants = DEFS.pad.power;
  if (p.launchT > 0) { p.launchT--; p.status = 'Launch!'; return; }
  if (!p.rocket) {
    for (let s = 0; s < 4 && !p.rocket; s++) for (const [x, y] of sideTiles(p, s)) {
      const v = get(x, y);
      if (v && v.type === 'vab' && (v.outb.rocket || 0) >= 1) { v.outb.rocket--; p.rocket = true; hooks.onEvent('rollout', { x: p.x, y: p.y }); break; }
    }
  }
  const lox = p.fin.lox || 0;
  if (lox > 0) { const b = Math.min(lox, (p.rocket ? 1.2 : .4) * DT); p.fin.lox = lox - b; p.boil = b; }   // boil-off
  if (!p.rocket) { p.status = 'Awaiting rollout from VAB'; return; }
  if (!padReady(p)) { p.status = `Loading propellant — RP-1 ${Math.floor(p.fin.rp1 || 0)}/${PAD_RP1}, LOX ${Math.floor(p.fin.lox || 0)}/${PAD_LOX}`; return; }
  p.status = 'GO for launch';
  if (p.auto && hives.length && tick % 30 === 0) {
    const cx = p.x + 3, cy = p.y + 3; let best = null, bd = 1e18;
    for (const h of hives) { const d = (h.x - cx) * (h.x - cx) + (h.y - cy) * (h.y - cy); if (d < bd) { bd = d; best = h; } }
    if (best) launch(p, best.x, best.y);
  }
}
function launch(p, tx, ty) {
  if (!padReady(p)) return false;
  p.rocket = false; p.fin.rp1 = 0; p.fin.lox = 0; p.launchT = 180;
  const x0 = p.x + 3, y0 = p.y + 3, dx = tx - x0, dy = ty - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  flights.push({ x0, y0, tx, ty, t: 0, dur: Math.round(240 + dist * 3) });
  stats.launches++; stats.co2 += 300;
  hooks.onEvent('launch', { x: x0, y: y0, tx, ty });
  return true;
}
function strike(f) {
  let k = 0;
  for (let i = hives.length - 1; i >= 0; i--) {
    const h = hives[i], dx = h.x - f.tx, dy = h.y - f.ty;
    if (dx * dx + dy * dy <= BLAST_R * BLAST_R) { hives.splice(i, 1); k++; }
  }
  const R = BLAST_R + 2;
  for (let y = f.ty - R; y <= f.ty + R; y++) for (let x = f.tx - R; x <= f.tx + R; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    if ((x - f.tx) * (x - f.tx) + (y - f.ty) * (y - f.ty) <= R * R && creep[x + y * W]) { creep[x + y * W] = 0; hooks.onCreep(x + y * W); }
  }
  stats.kills += k;
  for (let i = bugs.length - 1; i >= 0; i--) { const b = bugs[i]; if ((b.x - f.tx) ** 2 + (b.y - f.ty) ** 2 <= (BLAST_R + 1) ** 2) { bugs.splice(i, 1); stats.bugsKilled++; } }
  hooks.onEvent('impact', { x: f.tx, y: f.ty, kills: k });
}
// ---- bugs: hives grow, spread infestation, and bud new hives
const BUD_DIR = [[1,0],[.924,.383],[.707,.707],[.383,.924],[0,1],[-.383,.924],[-.707,.707],[-.924,.383],[-1,0],[-.924,-.383],[-.707,-.707],[-.383,-.924],[0,-1],[.383,-.924],[.707,-.707],[.924,-.383]];
function addHive(x, y, pop) {
  hives.push({ id: nextHive++, x, y, pop });
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
    const cx = x + i, cy = y + j;
    if (i * i + j * j <= 5 && !isWater(cx, cy) && !inSafe(cx, cy) && !creep[cx + cy * W]) { creep[cx + cy * W] = 1; hooks.onCreep(cx + cy * W); }
  }
}
// No infestation ever reaches the home base: a 90-tile safe zone around the landing site.
const SAFE_R = 90;
const inSafe = (x, y) => (x - SPAWN.x) * (x - SPAWN.x) + (y - SPAWN.y) * (y - SPAWN.y) < SAFE_R * SAFE_R;
function creepAdj(x, y) { for (let d = 0; d < 4; d++) { const nx = x + DX[d], ny = y + DY[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && creep[nx + ny * W]) return true; } return false; }
function updBugs() {
  if (tick % 60 === 0) for (const h of hives) h.pop = Math.min(10, h.pop + .006);
  if (tick % 60 === 0) for (const h of hives) {
    const r = 2 + h.pop * 1.1;
    for (let a = 0; a < 3; a++) {
      const x = h.x + Math.round((rand() * 2 - 1) * r), y = h.y + Math.round((rand() * 2 - 1) * r);
      if (x < 0 || y < 0 || x >= W || y >= H || isWater(x, y) || inSafe(x, y) || creep[x + y * W]) continue;
      if ((x - h.x) * (x - h.x) + (y - h.y) * (y - h.y) > r * r || !creepAdj(x, y)) continue;
      creep[x + y * W] = 1; hooks.onCreep(x + y * W);
      const e = cells[x + y * W]; if (e && !e.infested) { e.infested = true; hooks.onEvent('infested', { x, y, type: e.type }); }
    }
  }
  if (tick % 120 === 0 && hives.length < 40) for (const h of hives.slice()) {
    if (h.pop < 7 || rand() > .04) continue;
    const [ux, uy] = BUD_DIR[(rand() * 16) | 0], d = 6 + rand() * 5;
    const x = Math.round(h.x + ux * d), y = Math.round(h.y + uy * d);
    if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2 || isWater(x, y) || inSafe(x, y) || cells[x + y * W]) continue;
    if (hives.some(o => (o.x - x) * (o.x - x) + (o.y - y) * (o.y - y) < 16)) continue;
    h.pop -= 4; addHive(x, y, 1);
    hooks.onEvent('hive', { x, y });
  }
  if (tick > RAID_START) for (const h of hives) {
    h.raidT = (h.raidT || 0) + 1;
    const every = Math.max(45, 150 - Math.floor((tick - RAID_START) / 3600) * 3) * 60;   // raids grow more frequent
    if (h.raidT >= every + (h.id * 997) % 1800) { h.raidT = 0; raid(h); }
  }
  for (const b of bugs.slice()) updBug(b);
  if (tick % 60 === 0) for (const e of ents) if (e.hp !== undefined && tick - (e.hitT || 0) > 300) { e.hp = Math.min(entHpMax(e), e.hp + 2); if (e.hp >= entHpMax(e)) delete e.hp; }
  for (let i = flights.length - 1; i >= 0; i--) { const f = flights[i]; if (++f.t >= f.dur) { flights.splice(i, 1); strike(f); } }
}
function newWorld(seed) {   // a fresh procedurally generated world (call on pristine state)
  genWorld(seed);
  creep.fill(0); hives.length = 0; bugs.length = 0; flights.length = 0; nextHive = 1;
  for (const [x, y] of hiveSites()) addHive(x, y, 3);
}
newWorld(1);
// ---- raiding swarms
const entHpMax = e => { const [fw, fh] = fp(e.type, e.dir); return 40 + 30 * fw * fh; };
function nearestEnt(x, y) {
  let best = null, bd = 1e18;
  for (const e of ents) {
    if (e.type === 'road') continue;
    const [fw, fh] = fp(e.type, e.dir), dx = e.x + fw / 2 - x, dy = e.y + fh / 2 - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
function destroyEnt(e) {
  const [fw, fh] = fp(e.type, e.dir);
  for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) cells[e.x + i + (e.y + j) * W] = null;
  ents.splice(ents.indexOf(e), 1); e.dead = true; stats.lost++;
  rebuild();
  hooks.onEvent('destroyed', { x: e.x, y: e.y, type: e.type });
}
function killBug(b) { const i = bugs.indexOf(b); if (i >= 0) bugs.splice(i, 1); stats.bugsKilled++; hooks.onEvent('bugdie', { x: b.x, y: b.y }); }
function raid(h) {
  const tgt = nearestEnt(h.x, h.y); if (!tgt) return;
  const n = Math.min(MAX_BUGS - bugs.length, 2 + Math.floor(h.pop / 2));
  for (let k = 0; k < n; k++) bugs.push({ id: nextBug++, x: h.x + .5 + (rand() - .5) * 3, y: h.y + .5 + (rand() - .5) * 3, hp: BUG_HP, tgt, bite: 0, h: 0 });
  if (n > 0) hooks.onEvent('raid', { x: h.x, y: h.y, n, tx: tgt.x, ty: tgt.y });
}
const walkable = (x, y) => !isWater(Math.floor(x), Math.floor(y));
function updBug(b) {
  if (!b.tgt || b.tgt.dead) b.tgt = nearestEnt(b.x, b.y);
  const t = b.tgt; if (!t) return;
  const [fw, fh] = fp(t.type, t.dir);
  const nx = Math.max(t.x, Math.min(t.x + fw, b.x)), ny = Math.max(t.y, Math.min(t.y + fh, b.y));
  const dx = nx - b.x, dy = ny - b.y, d = Math.sqrt(dx * dx + dy * dy);
  if (d < .55) {
    b.bite++;
    if (t.hp === undefined) t.hp = entHpMax(t);
    t.hp -= BUG_DPS * DT; t.hitT = tick;
    if (t.hp <= 0) destroyEnt(t);
    return;
  }
  const vx = dx / d * BUG_SPEED, vy = dy / d * BUG_SPEED;
  for (const [mx, my] of [[vx, vy], [(vx - vy) * .7071, (vy + vx) * .7071], [(vx + vy) * .7071, (vy - vx) * .7071], [-vy, vx], [vy, -vx]]) {
    if (walkable(b.x + mx * 8, b.y + my * 8)) { b.x += mx; b.y += my; b.h = dirOf(mx, my); return; }
  }
}
const dirOf = (x, y) => Math.abs(x) > Math.abs(y) ? (x > 0 ? 1 : 3) : (y > 0 ? 2 : 0);
function updTurret(e) {
  const tri = e.type === 'sentry';
  e.wants = tri ? 0 : DEFS.turret.power;
  if (e.cool > 0) e.cool--;
  if (!tri && satO <= 0) { e.status = 'No power'; return; }
  if (e.rounds <= 0 && (e.inb.ammo || 0) >= 1) { e.inb.ammo--; e.rounds = TURRET_ROUNDS; }
  if (e.rounds <= 0) { e.status = 'No ammunition'; return; }
  const cx = e.x + (tri ? .5 : 1), cy = e.y + (tri ? .5 : 1), R = tri ? SENTRY_R : TURRET_R; let best = null, bd = R * R;
  for (const b of bugs) { const d = (b.x - cx) ** 2 + (b.y - cy) ** 2; if (d < bd) { bd = d; best = b; } }
  if (!best) { e.status = 'Watching'; return; }
  e.aimX = best.x; e.aimY = best.y; e.status = 'Engaging';
  if (e.cool <= 0) { e.cool = tri ? SENTRY_COOL : 12; e.rounds--; e.shotT = tick; stats.rounds++; if (--best.hp <= 0) killBug(best); }
}
function entInfested(e) { const [fw, fh] = fp(e.type, e.dir); for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) if (creep[e.x + i + (e.y + j) * W]) return true; return false; }

// =====================================================================
//  step
// =====================================================================
function step() {
  tick++;
  let pd = 0, od = 0, plantCap = 0, gridCap = 0;
  for (const e of ents) {
    if (e.type === 'pot') pd += e.wants; else od += e.wants || 0;
    if (e.type === 'powerplant') { updPlant(e); if (e.avail) plantCap += DEFS.powerplant.cap; }
    if (e.type === 'substation') gridCap += DEFS.substation.cap;
  }
  const cap = plantCap + gridCap, demand = pd + od;
  satP = pd > 0 ? Math.min(1, cap / pd) : 1;
  satO = od > 0 ? Math.min(1, Math.max(0, cap - pd) / od) : 1;
  const used = Math.min(cap, demand), fromPlants = Math.min(used, plantCap), fromGrid = used - fromPlants;
  Object.assign(power, { cap, plantCap, gridCap, demand, potDemand: pd, used, fromGrid });
  for (const e of ents) if (e.type === 'powerplant') runPlant(e, plantCap ? fromPlants / plantCap : 0);
  if (fromGrid > 0) { stats.gridMWs += fromGrid * DT; stats.co2 += fromGrid * DT * .0008; }
  for (const e of ents) if (e.type === 'substation') e.status = fromGrid > 0 ? `Importing ${fromGrid.toFixed(1)} MW` : 'Standby';

  depotShare = {}; for (const e of ents) if (e.type === 'depot') depotShare[e.sel] = (depotShare[e.sel] || 0) + 1;
  for (const e of ents) e.infested = e.type !== 'road' && e.type !== 'pipe' && e.type !== 'ptg' && entInfested(e);
  for (const e of ents) if (e.type === 'belt' && !e.infested) updateBelt(e);
  for (const e of ents) {
    if (e.infested) { e.wants = 0; e.status = 'Infested — bugs in the machinery'; continue; }
    switch (e.type) {
      case 'pot': updPot(e); break;
      case 'pump': updPump(e); break;
      case 'depot': updDepot(e); break;
      case 'feeder': updFeeder(e); break;
      case 'excavator': updExcavator(e); break;
      case 'drill': updDrill(e); break;
      case 'crusher': updCrusher(e); break;
      case 'washplant': updWash(e); break;
      case 'tailings': updTailings(e); break;
      case 'grader': updGrader(e); break;
      case 'road': if (e.sig) updSignal(e); break;
      case 'oilwell': updWell(e); break;
      case 'pad': updPad(e); break;
      case 'turret': case 'sentry': updTurret(e); break;
      default: if (DEFS[e.type].recipes) updMachine(e);
    }
  }
  for (const e of ents) if (e.type === 'inserter' && !e.infested) updInserter(e);
  // trucks: occupancy rebuilt each tick, processed in id order
  occ = new Map();
  for (const t of trucks) {
    if (t.man) { for (let h = 0; h < 4; h++) occAdd(t.tile, t, h); continue; }
    if (!t.parked || t.job) { occAdd(t.tile, t, t.h); if (t.next >= 0) occAdd(t.next, t, t.h); }
  }
  for (const t of trucks) if (t.man) updManual(t); else updTruck(t);
  updBugs();
}

// =====================================================================
//  commands (the only way players change the world)
// =====================================================================
const int = v => Number.isInteger(v) ? v : NaN;
function applyCmd(pid, c) {
  if (!c || typeof c !== 'object') return;
  const x = int(c.x), y = int(c.y);
  switch (c.k) {
    case 'place': if (DEFS[c.type] && !DEFS[c.type].tool) place(c.type, x, y, (c.dir | 0) & 3, false, pid); break;
    case 'remove': { const e = get(x, y); if (e) removeEnt(e, pid); break; }
    case 'rotate': { const e = get(x, y); if (e) { rotateEnt(e, c.d === 3 ? 3 : 1); if (e.type === 'excavator' && e.fx !== undefined) { e.hx = DX[e.dir]; e.hy = DY[e.dir]; } } break; }
    case 'setdir': { const e = get(x, y); if (e && e.type === 'belt') { e.dir = (c.dir | 0) & 3; rebuild(); } break; }
    case 'depot': { const e = get(x, y); if (e && e.type === 'depot' && IMPORTS.includes(c.sel) && e.sel !== c.sel) { e.sel = c.sel; e.acc = 0; } break; }
    case 'hopper': { const e = get(x, y); if (e && e.type === 'hopper' && (c.mat === null || BULK.has(c.mat)) && e.stock < 1) { e.mat = c.mat; e.stock = 0; } break; }
    case 'signal': toggleSignal(x, y, pid); break;
    case 'pit': { const x1 = int(c.x1), y1 = int(c.y1); if (x >= 0 && y >= 0 && x1 >= 0 && y1 >= 0) setPit(x, y, x1, y1, !!c.on); break; }
    case 'truck': spawnTruck(x, y, pid); break;
    case 'rmtruck': removeTruck(c.id | 0); break;
    case 'launch': { const e = get(x, y); const tx = int(c.tx), ty = int(c.ty); if (e && e.type === 'pad' && tx >= 0 && ty >= 0 && tx < W && ty < H) launch(e, tx, ty); break; }
    case 'enter': {
      if (c.tr !== undefined) enterTruck(pid, trucks.find(t => t.id === (c.tr | 0)));
      else { const e = get(c.ex | 0, c.ey | 0); if (e && e.type === 'excavator' && !e.drv && !truckOf(pid) && !excOf(pid)) { e.drv = pid; e.th = 0; e.st = 0; } }
      break;
    }
    case 'exit': exitVehicle(pid); break;
    case 'drive': {
      const t = truckOf(pid);
      if (t) { t.th = Math.max(-1, Math.min(1, c.th | 0)); t.st = Math.max(-1, Math.min(1, c.st | 0)); }
      const e = excOf(pid); if (e) { e.th = Math.max(-1, Math.min(1, c.th | 0)); e.st = Math.max(-1, Math.min(1, c.st | 0)); }
      break;
    }
    case 'act': { const t = truckOf(pid); if (t) t.act = !t.act; break; }
    case 'digat': { const e = excOf(pid); if (e) { const i = c.i | 0; e.pref = i >= 0 && i < W * H ? i : -1; } break; }
    case 'shoot': { const b = bugs.find(b => b.id === (c.id | 0)); const px = +c.px, py = +c.py;
      if (b && isFinite(px) && isFinite(py) && (b.x - px) ** 2 + (b.y - py) ** 2 <= SHOOT_R * SHOOT_R) { if (--b.hp <= 0) killBug(b); } break; }
    case 'padauto': { const e = get(x, y); if (e && e.type === 'pad') e.auto = !!c.on; break; }
    default: return;
  }
  hooks.onCmd(pid, c);
}

// =====================================================================
//  snapshot / checksum
// =====================================================================
const SKIP = new Set(['ports', 'net', 'under', 'con', 'active', 'dead']);
function serialize() {
  const idx = new Map(); ents.forEach((e, i) => idx.set(e, i));
  const es = ents.map(e => {
    const o = {};
    for (const k in e) if (!SKIP.has(k)) o[k] = e[k];
    if (e.items) o.items = e.items.map(i => ({ type: i.type, pos: i.pos, tk: i.tk }));
    if ('active' in e) o.ai = e.active ? DEFS[e.type].recipes.indexOf(e.active) : -1;
    return o;
  });
  const ns = nets.map(n => [idx.get(n.pipes[0]), n.fluid, n.amt]);
  const ts = trucks.map(t => ({ ...t, job: t.job ? { src: idx.get(t.job.src), sink: idx.get(t.job.sink), m: t.job.m } : null, path: t.path.slice() }));
  const od = [], obd = [], cr = [], fr = [], pm = [];
  for (let i = 0; i < W * H; i++) {
    if (frag[i]) fr.push(i);
    if (pit[i]) pm.push(i);
    if (oreAmt[i] !== oreInitAmt[i] || oreType[i] !== oreInit[i]) od.push(i, oreType[i] ? oreAmt[i] : -1);
    if (ob[i] !== obInit[i]) obd.push(i, ob[i]);
    if (creep[i]) cr.push(i);
  }
  return { v: 7, fr, pm, hp: heaps.map(h => ({ ...h })), W, H, seed: SEED, sp: [SPAWN.x, SPAWN.y], tick, stores: { ...stores }, rs, satP, satO, nextTruck, nextHive, stats: JSON.parse(JSON.stringify(stats)), power: { ...power }, es, ns, ts, od, obd,
    cr, hv: hives.map(h => ({ ...h })), fl: flights.map(f => ({ ...f })), nextBug, bg: bugs.map(b => ({ id: b.id, x: b.x, y: b.y, hp: b.hp, bite: b.bite, h: b.h, tgt: b.tgt && !b.tgt.dead ? idx.get(b.tgt) : -1 })) };
}
function load(s) {
  ents.length = 0; trucks.length = 0; cells.fill(null); nets = [];
  tick = s.tick; rs = s.rs; satP = s.satP;
  for (const k in stores) delete stores[k]; Object.assign(stores, s.stores); satO = s.satO; nextTruck = s.nextTruck || 1;
  for (const k in stats) delete stats[k]; Object.assign(stats, s.stats); Object.assign(power, s.power);
  if (s.seed !== SEED) genWorld(s.seed);
  else for (let i = 0; i < W * H; i++) { oreType[i] = oreInit[i]; oreAmt[i] = oreInitAmt[i]; ob[i] = obInit[i]; }
  for (let k = 0; k < s.od.length; k += 2) { const i = s.od[k]; if (s.od[k + 1] < 0) { oreType[i] = null; oreAmt[i] = 0; } else oreAmt[i] = s.od[k + 1]; }
  for (let k = 0; k < s.obd.length; k += 2) ob[s.obd[k]] = s.obd[k + 1];
  creep.fill(0); for (const i of s.cr) creep[i] = 1;
  frag.fill(0); for (const i of s.fr || []) frag[i] = 1;
  pit.fill(0); for (const i of s.pm || []) pit[i] = 1;
  heaps.length = 0; for (const h of s.hp || []) heaps.push({ ...h });
  hives.length = 0; for (const h of s.hv) hives.push({ ...h });
  flights.length = 0; for (const f of s.fl) flights.push({ ...f });
  nextHive = s.nextHive || 1;
  nextBug = s.nextBug || 1;
  for (const o of s.es) {
    const e = makeEnt(o.type, o.x, o.y, o.dir);
    for (const k in o) if (k !== 'ai') e[k] = o[k];
    if ('ai' in o) e.active = o.ai >= 0 ? DEFS[e.type].recipes[o.ai] : null;
    computePorts(e);
    const [fw, fh] = fp(e.type, e.dir);
    for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) cells[e.x + i + (e.y + j) * W] = e;
    ents.push(e);
  }
  if (!s.hp) for (const e of ents) if (e.type === 'excavator') {   // older saves kept heaps on the excavator
    if (e.pile >= 1 && e.pileMat) { const [x, y] = heapPos(e, 'pile'); heaps.push({ x, y, m: e.pileMat, t: e.pile, ga: e.ga, gs: e.gs }); }
    if (e.spoil > 0) { const [x, y] = heapPos(e, 'spoil'); heaps.push({ x, y, m: 'spoil', t: e.spoil }); }
  }
  refreshBelts(); rebuildNets();
  for (const [i, f, a] of s.ns) { const p = ents[i]; if (p && p.net) { p.net.fluid = f; p.net.amt = a; } }
  bugs.length = 0; for (const o of s.bg || []) bugs.push({ ...o, tgt: o.tgt >= 0 ? ents[o.tgt] : null });
  for (const o of s.ts) trucks.push({ ...o, job: o.job ? { src: ents[o.job.src], sink: ents[o.job.sink], m: o.job.m } : null });
}
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
function checksum() {
  let h = 2166136261 | 0;
  const mix = v => { f64[0] = +v || 0; h = Math.imul(h ^ u32[0], 16777619); h = Math.imul(h ^ u32[1], 16777619); };
  mix(tick); for (const k of Object.keys(stores).sort()) mix(stores[k]); mix(ents.length); mix(trucks.length); mix(rs); mix(heaps.length); for (const h of heaps) mix(h.t);
  for (const e of ents) {
    mix(e.x); mix(e.y); mix(e.dir);
    if (e.items) for (const it of e.items) mix(it.pos);
    if (e.prog !== undefined) mix(e.prog);
    if (e.a !== undefined) mix(e.a);
    if (e.T !== undefined) { mix(e.T); mix(e.al); mix(e.metal); }
    if (e.stock !== undefined) mix(e.stock);
    if (e.pile) mix(e.pile);
    if (e.cyc) mix(e.cyc);
    if (e.wear) mix(e.wear);
    if (e.fill !== undefined) mix(e.fill);
    if (e.gt !== undefined) { mix(e.gt); mix(e.gp); }
    if (e.holes) { mix(e.holes.length); mix(e.dprog); mix(e.fuse); mix(e.lx); mix(e.ly); }
    if (e.ga !== undefined) mix(e.ga);
    if (e.fx !== undefined) { mix(e.fx); mix(e.fy); mix(e.hx); }
    if (e.inb) for (const k in e.inb) mix(e.inb[k]);
    if (e.fin) for (const k in e.fin) mix(e.fin[k]);
    if (e.net) mix(e.net.amt);
  }
  for (const t of trucks) { mix(t.tile); mix(t.p); mix(t.load); mix(t.next); if (t.ga !== undefined) mix(t.ga); if (t.man) { mix(t.mx); mix(t.my); mix(t.hx); mix(t.v); } }
  mix(hives.length); for (const h of hives) { mix(h.x); mix(h.y); mix(h.pop); }
  mix(flights.length); for (const f of flights) mix(f.t);
  mix(bugs.length); for (const b of bugs) { mix(b.x); mix(b.y); mix(b.hp); }
  for (const e of ents) if (e.hp !== undefined) mix(e.hp);
  return h >>> 0;
}

// =====================================================================
//  export
// =====================================================================
const Sim = {
  T, W, H, DX, DY, DIRN, DT, CHEST_CAP, RESIDUE_CAP, BIN_CAP, TRUCK_CAP, EXC_REACH, ALUMINA_PER_FEED,
  ITEMS, FLUIDS, BULK, ALLOC, IMPORTS, MATS, DEFS, GROUPS, POT_IN, stores, costOf, canAfford, shortOf,
  hash, mulberry, vnoise, fbm, waterField, water, isWater, oreType, oreAmt, ob, oreInit, oreInitAmt, obInit,
  cells, ents, trucks, heaps, stats, power, hooks, creep, hives, flights, bugs, releaseAll, EXC_PILE_CAP, BUG_HP, TURRET_R, SENTRY_R, SHOOT_R, RAID_START, entHpMax, BLAST_R, PAD_RP1, PAD_LOX, NOHANDLE, isOre, padReady,
  get, fp, l2w, makeEnt, canPlace, placeError, place, removeEnt, beltPoint, handPos, isPipe, isJunction, bays, excTiles,
  hard, gA, gS, elev0, frag, pit, depthM, elevAt, benchOf, needsBlast, digFactor, capOf, DENS, SWELL, ROM_OF, CRUSHED, ROM_PAD, DRILL_R, GRADER_R, PATTERN, TAIL_CAP, BUCKET_M3, DEF_G, GRADED, gradeOf, bucketT, cycleOf, speedFor, gradeBetween,
  step, applyCmd, serialize, load, checksum, newWorld, SPAWN, SAFE_R, get seed() { return SEED; }, get patches() { return patchList; },
  get tick() { return tick; }, get satP() { return satP; }, get satO() { return satO; }, get nets() { return nets; },
};
if (typeof module === 'object' && module.exports) module.exports = Sim; else root.Sim = Sim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
