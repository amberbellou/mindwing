# Mindwing

**A tiny browser game about how AI works, and how to keep your mind your own.**

Play it here: **https://amberbellou.github.io/mindwing/**

You are Lumen, a fairy guarding the Grove of Minds. The Engagement Engine, a machine that feeds on attention, has sent its fire-eagles to scorch the grove. Fly, shoot sparks, and turn the eagles back. Every level teaches one idea about how modern AI systems work and how they affect the people who use them.

## What it teaches

| Level | Grove | Concept |
|---|---|---|
| 1 | Token Thicket | **Tokens**: language models chop text into chunks and predict the next one. They continue patterns; they do not check truth. |
| 2 | Pattern Canopy | **Neural networks**: billions of tuned weights arranged in layers. Knowledge is spread across all of them, which is why a model can be brilliant and confidently wrong at once. |
| 3 | Retention Ridge | **Retention models**: apps, including AI apps, are optimized to measure and maximize the time you spend. Streaks, feeds, and "one more question" are design, not accident. |
| 4 | The Engine's Roost (boss) | **Cognitive offloading and cognitive drift**: letting a tool think for you until your own skills fade, and letting it slowly steer your attention and opinions away from your own goals. |

## How the learning is delivered

The game is built around the idea that a message lands best when it arrives at a moment the player is already paying attention.

- **Start of the game**: a short story frame, the controls, and Lesson 1.
- **Between levels**: one focused lesson card per concept, each ending in a practical "Field note" the player can use the same day.
- **When you get hit**: the game pauses on a one-sentence "spark of insight" drawn from a rotating set of ten facts and self-check questions. Getting hit is the moment a player is most likely to actually read, and the short pause doubles as a breather.
- **Game over**: an encouraging retry screen that repeats one insight, so even losing teaches something.
- **When you win**: a recap "field guide" that consolidates all four concepts into four sentences.

The pause screen itself asks a small reflective question about whether the break was chosen on purpose, which is the game's central theme in miniature.

Language is pitched for roughly ages 11 and up. It avoids jargon where possible and defines every technical term the first time it appears.

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD | Fly |
| SPACE (tap or hold) | Shoot sparks |
| Double-tap SPACE | Clarity Burst: blanks the surroundings, clearing all eagles and fireballs on screen (limited charges, shown as ✦) |
| Touch: drag | Fly (auto-fires while touching) |
| Touch: double-tap | Clarity Burst |
| P | Pause |
| M | Mute |

Purple **insight motes** dropped by defeated eagles refill Clarity Burst charges. Finishing a level without taking damage earns a focus bonus.

## Running it

It is a single `index.html` file with no dependencies, no build step, no network requests, and no external assets. Open the file in any modern browser, or serve the folder with any static server. It works offline and on phones and tablets (on a phone, turn it sideways to landscape for the best view).

Sound is generated with the Web Audio API (no audio files). Press M to mute.

**For reviewers with limited time:** add `?level=2`, `?level=3`, or `?level=4` to the URL to start at that level (with its lesson card). For example: https://amberbellou.github.io/mindwing/?level=4 jumps to the boss.

## Design notes

- Everything is drawn procedurally on a `<canvas>` (the fairy, the eagles, the mechanical boss, fireballs, particles, parallax sky).
- Lesson and message text lives at the top of the script in three plain arrays (`LESSONS`, `HIT_FACTS`, `LEVELS`) so educators can edit the content without touching game code.
- The best score is remembered in `localStorage` on the player's device only. Nothing is sent anywhere.

## License

MIT. See [LICENSE](LICENSE).
