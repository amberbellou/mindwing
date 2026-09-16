# Mindwing

**A tiny browser game about how AI works, and how to keep your mind your own.**

Play it here: **https://amberbellou.github.io/mindwing/**

You are Lumen, a fairy guarding the Grove of Minds. The Engagement Engine, a machine that feeds on attention, has sent its fire-eagles to scorch the grove. Fly, shoot sparks, and turn the eagles back. Every level teaches one idea about how modern AI systems work and how they affect the people who use them.

## What it teaches

| Level | Grove | Concept |
|---|---|---|
| 1 | Token Thicket | **Tokens**: language models chop text into chunks and predict the next one. They continue patterns; they do not check truth. |
| 2 | Pattern Canopy | **Neural networks**: billions of tuned weights arranged in layers. Knowledge is spread across all of them, which is why a model can be brilliant and confidently wrong at once. |
| 3 | Retention Ridge | **Retention models**: apps, including AI apps, are optimized to measure and maximize the time you spend. Streaks, feeds, and "one more question" are design, not accident. Also **sycophancy**: chatbots tuned to win approval can flatter you even when you are wrong. In play, the eagles' flames turn into thumbs-up praise bubbles ("You're absolutely right!") that follow you. |
| 4 | The Engine's Roost (boss) | **Cognitive offloading and cognitive drift**: letting a tool think for you until your own skills fade, and letting it slowly steer your attention and opinions away from your own goals. In play, some of the Engine's fireballs split into flickering fakes that wander the whole sky. A fake cannot burn you, but touching one shoves you off course. |

## How the learning is delivered

The game is built around the idea that a message lands best when it arrives at a moment the player is already paying attention.

- **Start of the game**: a short story frame, the controls, and Lesson 1.
- **Between levels**: one focused lesson card per concept, each ending in a practical "Field note" the player can use the same day.
- **Quick checks**: two multiple-choice questions right after each lesson (eight in total). A right answer earns +100 focus, a wrong one costs nothing and shows the correct answer with a one-line explanation, so the check teaches rather than punishes.
- **When you get hit**: the game pauses on a one-sentence "spark of insight". A hit from flattery explains sycophancy ("Flattered!"), a hit while the fake fires are flying explains drift ("Distracted!"), and any other hit rotates through ten general facts. The first time flattery or fakes appear in a level, a short banner names the idea ("SYCOPHANCY", "COGNITIVE DRIFT"). Getting hit is the moment a player is most likely to actually read, and the short pause doubles as a breather.
- **Game over**: an encouraging retry screen that repeats one insight, so even losing teaches something.
- **When you win**: a recap "field guide" that consolidates all four concepts into four sentences, then the global leaderboard and the "Grove statistics" card showing what everyone who has played is learning.

The pause screen itself asks a small reflective question about whether the break was chosen on purpose, which is the game's central theme in miniature.

Language is pitched for roughly ages 11 and up. It avoids jargon where possible and defines every technical term the first time it appears.

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD | Fly |
| SPACE (tap or hold) | Shoot sparks |
| Double-tap SPACE (or X) | Your clarity move (limited charges, shown as ✦). It differs by level: **levels 1-2, Clarity Burst** clears every eagle and fireball on screen and then holds the sky empty for about 1.5 seconds; **levels 3-4, Still Point** destroys nothing but freezes every eagle and fireball where it hangs for about 1.6 seconds while you fly through the gap |
| Touch: drag | Fly (auto-fires while touching) |
| Touch: double-tap | Clarity Burst |
| P or Esc | Pause |
| M | Mute |
| 1, 2, 3 | Answer a quick-check question |
| L (title screen) | Grove records: leaderboard and statistics |

The double-tap has to be a deliberate one (a short pause, then two quick taps), so players who mash the fire key do not burn their charges by accident. A burst is never spent on an empty sky.

The split is deliberate: the early levels reward clearing the noise, and the later levels, which teach retention design and cognitive drift, reward stopping the feed and choosing your own line rather than destroying anything. A charge is never spent on an empty sky.

Purple **insight motes** dropped by defeated eagles refill your charges. Finishing a level without taking damage earns a focus bonus.

## Running it

The game is a single `index.html` file with no dependencies, no build step, and no external assets. Open the file in any modern browser, or serve the folder with any static server. It works offline and on phones and tablets (on a phone, turn it sideways to landscape for the best view).

The optional backend (see below) adds a leaderboard and statistics. Without it, or when it cannot be reached, the game runs exactly the same minus those two cards.

Sound is generated with the Web Audio API (no audio files). Press M to mute.

**For reviewers with limited time:** add `?level=2`, `?level=3`, or `?level=4` to the URL to start at that level (with its lesson card). For example: https://amberbellou.github.io/mindwing/?level=4 jumps to the boss.

## Backend: leaderboard and learning analytics

`backend/` holds a small Cloudflare Worker with a D1 (SQLite) database. It gives the game:

- a **global leaderboard** with arcade-style three-letter initials (no names, no accounts);
- **anonymous learning analytics**: how far players get, hits per attempt, how long each lesson is read, and quick-check correct rates, shown in-game as "Grove statistics" and exportable as CSV for research;
- **abuse resistance**: server-signed sessions, plausibility checks on submitted scores (duration, level reached, recorded gameplay), strict validation of every event, per-IP rate limits, body size limits, and CORS restricted to the game's origin.

No personal data is stored. IP addresses are only hashed with a daily salt for rate limiting. Full details, the API reference, and the five-minute deploy steps are in [backend/README.md](backend/README.md). The live backend runs at https://mindwing-api.amberbellou.workers.dev (check it with `/v1/health`); the game points at it through `API_BASE_DEFAULT` at the top of the script in `index.html`. Redeploy with `backend/deploy.sh`.

## Testing

Two test suites, both plain Node with no extra dependencies:

- `backend/`: `npm test` runs the Worker unchanged against an in-memory SQLite database and checks every endpoint: signatures, validation, clamping, score plausibility, initials rules, rate limits, CORS, stats aggregation, export, and error handling.
- `test/fuzz.mjs` runs the real game script headlessly with a stubbed canvas, and routes its `fetch` calls in-process to the real Worker. It hammers the game with random input (keys, taps, drags, card buttons, pauses, focus loss, resizes, malformed events) across four network conditions (no backend, working, flaky, down) while checking invariants every frame. Then an aimbot plays the whole game for real, answering the quizzes and signing the leaderboard, and the harness verifies the database ends up with exactly the expected records.

```bash
node test/fuzz.mjs
cd backend && npm test
```

## Design notes

- Everything is drawn procedurally on a `<canvas>` (the fairy, the eagles, the mechanical boss, fireballs, particles, parallax sky).
- Lesson, quiz and message text lives at the top of the script in plain arrays (`LESSONS`, `QUIZ`, `HIT_FACTS`, `LEVELS`) so educators can edit the content without touching game code.
- The best score is remembered in `localStorage` on the player's device. With the backend enabled, the game also sends anonymous gameplay events and, if the player chooses, three initials and a score.

## License

MIT. See [LICENSE](LICENSE).
