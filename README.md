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
| 4 | Mirage Marsh | **Hallucination**: a language model can produce fluent, confident answers that are false, including invented facts, quotes and sources. In play, answer orbs drift through the marsh: orbs with a ✓ source badge are real insight and refill a charge; the shinier, surer ones ("100% certain!", "Studies prove it!") are hallucinations that cost focus and a charge. |
| 5 | The Engine's Roost (boss) | **Cognitive offloading and cognitive drift**: letting a tool think for you until your own skills fade, and letting it slowly steer your attention and opinions away from your own goals. In play, some of the Engine's fireballs split into faded fakes with no bright center that wander the whole sky. A fake cannot burn you, but touching one shoves you off course. |

## Measuring what changed

The same five questions, one per concept, are asked **before playing** and again **after the Engine falls**. They are deliberately separate from the in-level quick checks, so the quick checks do not hand over the answers, and they are never scored: nothing in the game depends on them, and the "before" round is skippable in one click.

The player sees the difference on a card at the end ("You went from 1 of 5 before the flight to 5 of 5 now"). The teacher dashboard shows the class before and after, the gain in percentage points, a per-question breakdown, and each run's own pair. Answers are recorded as their own event types (`pre` and `post`), so the measure stays separate from the quick checks in the research export.

## Coming back later

The game remembers, in that browser only, the furthest level reached and the best score on each level. The title screen then offers **Continue from level N** alongside **Start again from level 1**, and lists the best score per level. A class period that runs out no longer means starting over.

## How the learning is delivered

The game is built around the idea that a message lands best when it arrives at a moment the player is already paying attention.

- **Start of the game**: a short story frame, the controls, and Lesson 1.
- **Between levels**: one focused lesson card per concept, each ending in a practical "Field note" the player can use the same day. A light runs around the card's frame while an eight-second reading time counts down, and the card cannot be skipped before it ends; the hint says so, and the frame holds gold when the quick check opens.
- **Quick checks**: two multiple-choice questions right after each lesson (ten in total). A right answer earns +100 focus, a wrong one costs nothing and shows the correct answer with a one-line explanation, so the check teaches rather than punishes.
- **When you get hit**: the game pauses on a one-sentence "spark of insight". A hit from flattery explains sycophancy ("Flattered!"), a hit while the fake fires are flying explains drift ("Distracted!"), and any other hit rotates through ten general facts. The first time flattery or fakes appear in a level, a short banner names the idea ("SYCOPHANCY", "COGNITIVE DRIFT"). Getting hit is the moment a player is most likely to actually read, and the short pause doubles as a breather.
- **Game over**: an encouraging retry screen that repeats one insight, so even losing teaches something.
- **When you win**: a recap "field guide" that consolidates all five concepts into five sentences, then the global leaderboard and the "Grove statistics" card showing what everyone who has played is learning.

The pause screen itself asks a small reflective question about whether the break was chosen on purpose, which is the game's central theme in miniature.

Language is pitched for roughly ages 11 and up. It avoids jargon where possible and defines every technical term the first time it appears.

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD | Fly |
| SPACE (tap or hold) | Shoot sparks |
| Double-tap SPACE (or X) | Your clarity move (limited charges, shown as ✦). It differs by level: **levels 1-2, Clarity Burst** clears every eagle and fireball on screen and then holds the sky empty for about 1.5 seconds; **levels 3-5, Still Point** destroys nothing but freezes every eagle and fireball where it hangs for about 1.6 seconds while you fly through the gap |
| Touch: drag | Fly (auto-fires while touching) |
| Touch: double-tap | Your clarity move (Clarity Burst or Still Point, by level) |
| P or Esc | Pause |
| M | Mute |
| 1, 2, 3 | Answer a quick-check question |
| L (title screen) | Grove records: leaderboard and statistics |
| S (title or pause) | Settings: difficulty and accessibility |

The double-tap has to be a deliberate one (a short pause, then two quick taps), so players who mash the fire key do not burn their charges by accident. A burst is never spent on an empty sky.

The split is deliberate: the early levels reward clearing the noise, and the later levels, which teach retention design and cognitive drift, reward stopping the feed and choosing your own line rather than destroying anything. A charge is never spent on an empty sky.

Purple **insight motes** dropped by defeated eagles refill your charges. Finishing a level without taking damage earns a focus bonus.

### Small things to chase, eat, and escape

A few mechanics borrowed from Loopy, an earlier fish-fairy side-scroller, chosen because each one is small and none of them touches the lessons:

- **Grove seeds**: tiny green seeds drift across the sky in small orbiting clusters. Fly through one to eat it (+10 focus). Every tenth seed pays a streak bonus, so there is a reason to use the whole sky and not only the firing line.
- **The glimmer**: once or twice a level a golden glimmer shimmers in for about two seconds and then is gone. Catch it for +150 focus and a burst of seeds. It is a variable reward on purpose, and the first one is named on screen ("VARIABLE REWARD") so the pattern is easier to spot in an app.
- **The hook** (levels 2 to 4): a dark homing shape with one red notification eye follows Lumen. It is slower than she is in a straight line but turns well. Outfly it for about seven seconds and it gives up ("outflown", +120); or turn and face it, since two sparks bring it down. Either answer is a choice, which is the point.
- **The serpent** (levels 2 to 5): a green snake with a trailing body follows Lumen with a slow, swaying turn. Seven sparks to the head bring it down, but the elegant answer is to lead it in a tight circle so its head crosses its own tail (the biteable part is ringed in gold once it is armed). Each crossing is a coil, shown as a gold dot and a "coiling 1/3" pop, and coils unwind if you stop; on the third it swallows itself for +200 and the line "Loops feed on themselves." A skilled circle takes four to five seconds.
- **Arc sparks**: while holding fire, every fifth spark fans two extra sparks out at an angle.
- **The fake serpent** (levels 4 and 5): a faded serpent with empty eye sockets and no bite. Sparks pass straight through it and it never costs a heart, but touching it shoves Lumen off her line, the same pull the decoy fires make. It is cognitive drift in serpent form: the missing bright centre is the tell.
- **The opening** (boss, final phase): every few seconds the Engine stops firing for a moment and glows white. Sparks land in full only then; the rest of the time they mostly glance off its plating. Aim for the pause. Spam is not the same as aim.

## Feel

- **Music**: a small generative synthwave score made in the browser (no audio files): a lead of two detuned sawtooths through a filter that opens on every note, an eighth-note bass, a kick and hi-hats, a soft chord pad, and a dotted-eighth echo. Each level has its own key and tempo, from 104 to 128 beats per minute, and the chords walk a bright I, V, vi, IV so it stays uplifting even on the boss. It ducks under cards, goes quiet on pause, and can be switched off in Settings (M still mutes everything).
- **Impact**: a few frames of hit-stop when an eagle falls, when you are hurt, and when the boss changes phase or falls; floating score pop-ups; tumbling feathers; red edges when you lose a heart.
- **Eagles**: gliders, zigzaggers and divers are joined by **armored eagles** (levels 2 and 3: slower, plated, take two sparks, 200 points) and **swoopers** (level 3: cruise, then dive at where you are and climb away; the crest glows during the dive).
- **The final level** brings every enemy at once: all five eagle types, flattery shots, the hook, serpents, fake serpents, and the decoy fires, with a sturdier Engine (80 health on normal, from 55). Quotas on the earlier levels are 12, 16, 20 and 18 eagles, so each level is a little longer. The whole game runs at about 70% of its original pace.
- **Boss phases**: at half health the Engine overclocks and fires faster; below a quarter it announces "THE FEED NEVER ENDS" and alternates spiral volleys (a turning ring with a gap to fly through) with its aimed shots, and calls in an extra eagle.

## Settings: difficulty and accessibility

Press **S** on the title screen or the pause card. Settings are saved in the browser.

| Setting | Options | What changes |
|---|---|---|
| Difficulty | Easy, Normal, Hard | Easy: 5 hearts, 4 charges, slower and rarer shots, smaller quotas, gentler boss; scores count 0.6x. Hard: 2 charges, faster and more frequent shots, bigger quotas, tougher boss; scores count 1.3x. Quick-check points are never scaled. A change made mid-run starts at the next level. |
| Motion | Full, Reduced | Reduced removes screen shake, softens flashes, cuts sparks to a third, stops pulsing text, and makes the drift decoys steady with a dashed outline. (Decoys never flash quickly in any mode: they shimmer about once a second, since fast flashing can be a photosensitivity trigger.) Follows the device's reduce-motion preference by default. |
| Contrast | Standard, High | Brighter text and borders, a darker sky, a solid ring on every real fireball and a dashed ring on every decoy, and outlined empty hearts and charges, so no information depends on color alone. |
| Text size | Normal, Large | Larger text on every card and on the game screen. |
| Music | On, Off | The background score. M mutes everything. |
| Sound effects | On, Off | Shots, hits and pickups. Nothing in the game depends on hearing them, and music has its own setting, as the Game Accessibility Guidelines ask. |

## Running it

The game is a single `index.html` file with no dependencies, no build step, and no external assets. Open the file in any modern browser, or serve the folder with any static server. It works offline and on phones and tablets (on a phone, turn it sideways to landscape for the best view).

The optional backend (see below) adds a leaderboard and statistics. Without it, or when it cannot be reached, the game runs exactly the same minus those two cards.

Sound is generated with the Web Audio API (no audio files). Press M to mute.

**For reviewers with limited time:** add `?level=2` to `?level=5` to the URL to start at that level (with its lesson card). For example: https://amberbellou.github.io/mindwing/?level=4 opens the Mirage Marsh and `?level=5` jumps to the boss.

## For teachers: classes and a dashboard

Open **[teacher.html](https://amberbellou.github.io/mindwing/teacher.html)** (also linked from the game's title screen) and press **Create class**. No account is needed. You get:

1. a **class code** and a **student link** (`https://amberbellou.github.io/mindwing/?class=CODE`) that opens the game already joined to the class. The game remembers the class in that browser; students see the class name on the title screen, a plain statement of what the teacher can see, and a **Leave class** button;
2. a **private dashboard link**, shown once. It carries a key that only this browser page sends to the backend; the backend stores only a SHA-256 hash of it, so a lost link cannot be recovered.

The dashboard shows, for the whole class, how far students got, hits per attempt on each level, lesson reading time, every quick-check question with its correct rate, and how well students told real answers from hallucinated ones in the Mirage Marsh. Below that is one row per run: the three-letter initials if the student signed the leaderboard, start time, difficulty, furthest level, result, score, hits, quick checks right, answer orbs grabbed, and minutes played, with a CSV download. Quick checks below half right are highlighted. No names are collected; the page reminds teachers that initials in a small class can still point to a child.

An unknown or mistyped class code never blocks play: the student is told the code was not found and the run is simply not attached to a class.

## Backend: leaderboard and learning analytics

`backend/` holds a small Cloudflare Worker with a D1 (SQLite) database. It gives the game:

- a **global leaderboard** with arcade-style three-letter initials (no names, no accounts);
- **anonymous learning analytics**: how far players get, hits per attempt, how long each lesson is read, quick-check correct rates, and real-versus-hallucinated answer orb choices, shown in-game as "Grove statistics" and exportable as CSV for research;
- **classes**: self-serve class codes and a key-protected teacher dashboard (see above);
- **abuse resistance**: server-signed sessions, plausibility checks on submitted scores (duration, level reached, recorded gameplay), strict validation of every event, per-IP rate limits, body size limits, and CORS restricted to the game's origin.

No personal data is stored. IP addresses are only hashed with a daily salt for rate limiting. Full details, the API reference, and the five-minute deploy steps are in [backend/README.md](backend/README.md). The live backend runs at https://mindwing-api.amberbellou.workers.dev (check it with `/v1/health`); the game points at it through `API_BASE_DEFAULT` at the top of the script in `index.html`. Redeploy with `backend/deploy.sh`.

## Submission materials

- [docs/SUBMISSION.md](docs/SUBMISSION.md): one-page overview for reviewers, with the concept-to-mechanic map, how learning is measured, a ten-minute evaluation path, accessibility, privacy, and background reading.
- [docs/screenshots/](docs/screenshots/): fifteen 1280x720 captures covering the title, story, lesson, checks, every level, the hit card, the boss, the all-enemies finale, and the teacher dashboard.

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
