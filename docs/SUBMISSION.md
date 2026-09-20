# Mindwing: submission overview

**A tiny browser game about how AI works, and how to keep your mind your own.**

- Play: https://amberbellou.github.io/mindwing/ (no install, no account, works offline once loaded)
- Teachers: https://amberbellou.github.io/mindwing/teacher.html
- Source: https://github.com/amberbellou/mindwing (MIT)
- Author: Amber Bellou

## The idea in one paragraph

Mindwing is a five-level arcade shooter for players aged roughly 11 and up. You are Lumen, a fairy guarding the Grove of Minds against the Engagement Engine, a machine that feeds on attention. Each level teaches one idea about modern language-model AI and its effect on the people who use it: tokens and next-token prediction, neural networks and distributed weights, retention design and sycophancy, hallucination, and cognitive offloading and drift. The design principle is that a message lands when it arrives at a moment the player is already paying attention, so the teaching is placed at those moments: a lesson before each level (with an eight-second reading time before it can be skipped, shown as a light running around the card), a one-line insight when you are hit, a named banner the first time a new trick appears, and a field guide when you win. Wherever possible the mechanic is the lesson, not an illustration of it.

## Where the mechanics carry the concepts

| Level | Concept | What the player experiences |
|---|---|---|
| 1 Token Thicket | Next-token prediction | The lesson card and quick checks establish that a chatbot continues patterns rather than checks truth. |
| 2 Pattern Canopy | Neural networks, weights | Armoured eagles take two sparks: not everything yields to the first answer. |
| 3 Retention Ridge | Retention design, sycophancy | Eagle flames turn into thumbs-up praise bubbles ("You're absolutely right!") that follow you. A homing "hook" trails you until you outfly it or turn and face it. The serpent, an enemy that only defeats itself when led to chase its own tail, is the picture of a loop feeding on its own output. |
| 4 Mirage Marsh | Hallucination | Answer orbs drift through the marsh. Real insight carries a checkable source badge and refills a charge; the shinier, surer orbs ("100% certain!") are hallucinations that cost you. The tell is a shape, never a colour alone. |
| 5 The Engine's Roost | Offloading and drift | Every enemy from the earlier levels returns at once, plus fake serpents: faded, eyeless, harmless to sparks and hearts, but touching one shoves you off your line. The boss's fireballs split into faded decoys with the same pull. In its final phase the Engine pauses to reload; only then do sparks land in full, so timing beats spamming. |

Between levels a card with a big lever asks for three pulls; each pull lights up one thing that is the player's own (love, curiosity, meaning, metaphor, imagination, and so on) with one careful line on what a machine can and cannot do with it. It is the counterweight to the warnings: fifteen lights across a run, none repeated. Two smaller devices run through all levels. A fleeting golden "glimmer" appears for two seconds and pays if caught; the first one is named on screen as a variable reward, so the pattern is easier to spot in an app. And the player's clarity move changes meaning halfway through: on levels 1 and 2 it clears the sky, on levels 3 to 5 it destroys nothing and instead freezes everything for a moment while you choose your own line, which is the retention and drift lesson played out in the controls.

## How learning is measured

- **Before and after.** The same five questions, one per concept, are asked before the first level and again after the Engine falls. They are deliberately different from the in-level quick checks, so the quick checks cannot simply hand over the answers, and they are never scored inside the game. The player sees the difference on a card at the end. The teacher dashboard shows the class gain in percentage points and a per-question breakdown.
- **Quick checks.** Two multiple-choice questions after each lesson, ten in total. Right answers earn focus; wrong ones cost nothing and show the correct answer with a one-line explanation, so the check teaches rather than punishes.
- **Behavioural signals.** Which orbs a player grabs in the marsh (checked versus hallucinated), which trick hit them (flattery, decoy, or ordinary), how long they spent on each lesson card, how far they got.
- **Learning analytics.** Anonymous events go to a small backend (Cloudflare Worker and D1). A public "Grove statistics" card shows every player what people are learning in aggregate. Teachers can create a class in one click and get a private dashboard with class averages, per-question results, and one row per run, plus CSV export.

Honest status of evidence: the measurement instrument is built and verified end to end on the live system, but no controlled study has been run yet. The pilot data at the time of writing are a handful of runs by the author and testers. The game is designed so that a classroom study needs nothing beyond a class link.

## What a judge can do in ten minutes

1. Open the play link and press SPACE. The story card, the controls, and the five "before" questions take about a minute (the check can be skipped with one click).
2. Play levels 1 and 2. Notice the lesson before each level, the quick check after it, and the insight card when you are hit.
3. Jump straight to a later level with a URL parameter: `?level=3` for flattery, the hook, and the serpent; `?level=4` for the hallucination orbs; `?level=5` for the boss.
4. Press S on the title screen for difficulty and accessibility settings (easy, normal, hard; reduced motion; high contrast; large text; music and sound effects separately).
5. Open the teacher page, create a class, and open the student link it gives you. The title screen now names the class and tells the student exactly what the teacher will see. Play a level, then refresh the dashboard.

## Accessibility and safety

- Keyboard, mouse, and touch. On touch, dragging flies and auto-fires; a double-tap is the clarity move.
- Reduced motion (defaults to the operating system preference), high contrast with shape-based tells, large text, and separate music and sound-effect switches.
- No fast flicker anywhere: the decoy shimmer and the glimmer pulse at about one cycle per second. This was checked against the basic level of the Game Accessibility Guidelines; control remapping and a game-speed slider are not yet offered.
- No accounts, no names, no email. Leaderboard entries are three letters, with a blocklist. Class dashboards are keyed by a code and a key shown once, and the key travels in the URL fragment, which browsers do not send to servers.
- Language pitched for ages 11 and up; every technical term is defined the first time it appears.

## Privacy and data

Analytics are anonymous and aggregate: a random per-browser id, level events, quiz answers by question number, orb choices, and timings. No free text is collected other than optional three-letter initials. The game runs fully offline if the backend is unreachable; no feature depends on it. The backend enforces signed sessions, per-IP rate limits sized for a classroom, score plausibility checks, and a request-size cap. Teachers can delete a class by asking the author; a self-service delete is on the roadmap.

## Technical notes

- One HTML file, no build step, no dependencies, about 2,000 lines of vanilla JavaScript on a 2D canvas. Generative synthwave music in the browser (no audio files): detuned sawtooth lead, filtered bass, kick and hats, chord pad and echo, one key and tempo per level.
- Tests: `node test/fuzz.mjs` runs the real game script headlessly with a stubbed canvas, hammers it with random input across four network conditions, plays it to completion with an aimbot against the real backend code in-process, and runs targeted scenarios for every mechanic and lesson. `cd backend && npm test` covers the API. Both pass at the time of writing.
- Performance: about half a millisecond per frame with a full sky on a laptop; phones have headroom. Landscape is the intended phone orientation.

## Background reading

The concepts are simplified for the audience. The sources below are the ones the simplifications rest on; readers who want the full picture should go there rather than to the game.

- Sharma, M., Tong, M., Korbak, T., Duvenaud, D., Askell, A., Bowman, S. R., Cheng, N., Durmus, E., Hatfield-Dodds, Z., Johnston, S. R., Kravec, S., Maxwell, T., McCandlish, S., Ndousse, K., Rausch, O., Schiefer, N., Yan, D., Zhang, M., and Perez, E. (2024). Towards Understanding Sycophancy in Language Models. *International Conference on Learning Representations (ICLR 2024)*. arXiv:2310.13548. On assistants trained from human preference judgements learning to agree with users. https://arxiv.org/abs/2310.13548
- Ji, Z., Lee, N., Frieske, R., Yu, T., Su, D., Xu, Y., Ishii, E., Bang, Y. J., Madotto, A., and Fung, P. (2023). Survey of Hallucination in Natural Language Generation. *ACM Computing Surveys*, 55(12), Article 248. On fluent, confident, false generation. https://doi.org/10.1145/3571730
- Risko, E. F., and Gilbert, S. J. (2016). Cognitive Offloading. *Trends in Cognitive Sciences*, 20(9), 676-688. On delegating thinking to tools, and its costs and benefits. https://doi.org/10.1016/j.tics.2016.07.002
- Jakesch, M., Bhat, A., Buschek, D., Zalmanson, L., and Naaman, M. (2023). Co-Writing with Opinionated Language Models Affects Users' Views. *Proceedings of the 2023 CHI Conference on Human Factors in Computing Systems (CHI '23)*. An online experiment with 1,506 participants in which a writing assistant biased toward one opinion shifted both what people wrote and what they then reported believing. https://doi.org/10.1145/3544548.3581196
- Eyal, N., with Hoover, R. (2014). *Hooked: How to Build Habit-Forming Products*. Portfolio/Penguin. ISBN 978-1-59184-778-6. A practitioner's playbook, not a study; it is the design pattern the retention level warns about.

"Cognitive drift" is the game's own name for the slow slide of attention, opinion, and style toward what a system feeds you. It is a framing for young players rather than an established term in the literature.

## Known limitations

- No formal learning study yet; the instrument is ready but the sample is tiny.
- The clarity move's double-tap needs a deliberate rhythm, which some players discover only from the controls card.
- Text is English only.
- A small pilot class's results are visible only to whoever holds the dashboard link; there is no account recovery by design.

## Development note

The game was designed, written, and tuned by the author, with an AI coding assistant used for implementation, testing harnesses, and verification. All teaching text and design decisions are the author's.
