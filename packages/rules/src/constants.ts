// Every number the match runs on. Units: 1 tile = 100; time in ticks (20 per second).

/** The rules version new matches use (see Setup.rules and bot.ts). */
export const CURRENT_RULES = 3;

export const TICK_HZ = 20;
/** 3:00 */
export const MAX_TICKS = 3600;
/** one sealed chunk = 3 seconds */
export const CHUNK = 60;
export const MAX_SEATS = 6;

export const HP = 5;
export const SPEED = 18;
export const DIAG = 13;
export const RADIUS = 30;

export const SWING_CD = 12;
export const SWING_RANGE = 160;
export const GRACE = 8;
export const KNOCK = 70;
export const DASH_TICKS = 5;
export const DASH_MULT = 3;
export const DASH_CD = 50;

/** torch radius */
export const VIEW = 650;
/** each carried ember makes you visible this much further away, for up to GLOW_MAX embers */
export const GLOW_PER_EMBER = 30;
export const GLOW_MAX = 10;

export const PICKUP = 60;
/** embers within MAGNET drift MAGNET_PULL units a tick towards the nearest Warden */
export const MAGNET = 140;
export const MAGNET_PULL = 16;
export const EMBERS_START = 20;
export const EMBER_EVERY = 30;
export const EMBER_UNTIL = 3200;
export const EMBER_LIMIT = 90;

/** the dark: radius R0 until DARK_START, shrinking linearly to R1 at DARK_END */
export const DARK_R0 = 2100;
export const DARK_R1 = 350;
export const DARK_START = 400;
export const DARK_END = 2800;
export const DARK_DMG_EVERY = 20;

/** EMBER economy (the contract uses the same numbers) */
export const STARTER = 30;
export const FEE = 5;
export const BURN_PER_FALLEN = 15;
export const BURN_MAX = 75;
export const MATCH_MINT_CAP = 40;
export const DAILY_MINT_CAP = 2000;
