# SKILL: writing perfect loops for MiniMax H3 (Alive Comics)

Learned on five books of 60 panels (October 2026). Source for humans: docs/BOUCLES-IA.html.
Apply it to EVERY living (looping) panel you write.

## Why loops break
A looping panel gives H3 the SAME image as first and last frame. H3 must end exactly where it started. Three failures:
- ROUND TRIP (the one the author hates most): if the text describes a gesture that "goes somewhere" (raise an arm,
  walk toward, turn, enter), H3 does it, then UNDOES it to get back: the second half looks like the first one played
  backwards.
- BRAKING at the seam: to land on the start image H3 slows down over the first and last 10-20 frames. (The player can
  compensate with "ease"; you do not need to write anything for it.)
- FROZEN panel: soft words ("slowly", "small", "stays in place") make H3 choose the safest loop: nothing moves.
Writing "loop", "seamless" or "perfect loop" alone does nothing. What works: describe ONLY motions whose end state is
identical to their start state WITHOUT going back.

## Principle: come back without going back
A good loop has no beginning and no end: at the last frame the motion is already starting again. Three ways, safest
first: (1) a continuous FLOW; (2) a CYCLIC gesture that always turns the same way, or a short gesture repeated many
times in 5 s; (3) a RELAY: whatever leaves the frame is replaced by an identical one entering, never coming back.
Always add a LIVING IDLE on every character.

## The four loop engines (each living panel = subjects in idle + at least one engine; they can be combined)
- flow: smoke or steam rising, rain, running water, a flame, a flickering TV screen, chasing light bulbs, a curtain
  rippling, dust in a light beam, falling confetti, landscape scrolling behind a window, clouds drifting one way,
  a washing-machine drum.
- relay: people crossing in ONE direction only, each leaving the frame (or passing behind an object) and replaced by
  an identical one: extras crossing a corridor at the back, passers-by, cars left to right, a technician walking away
  while another in the same overalls enters from the left.
- cycle: a gesture that TURNS, always the same way: stirring a coffee, wiping in small circles, polishing a shoe, a mop
  in figure-eights, a cable passing hand to hand, a fish circling in its bag, a clock, a waltz in a circle.
- rhythm: a SHORT gesture repeated fast and often (many periods in 5 s): chewing, tapping, dabbing powder, sewing,
  combing back and forth, nodding in rhythm, drumming fingers, leafing through pages, deep breathing while asleep.
Good reflex: say WHERE the flow goes (to the right, upward, toward the back) and that each element is replaced by the
next ("one after another", "leaving on the right as the next arrives from the left"). Never "and comes back".

## Living idle (add to EVERY character, even the most discreet)
"keeps a living idle: breathing visibly, blinking, the eyes drifting, the fabric and the hair trembling, the weight
shifting a touch from one foot to the other." Puffy fabrics (puffer, balloon, plastic) rise and fall with each breath;
shiny or pearly fabrics: the light rolls on the folds with each breath. Close-up faces: idle + a light flow (flame,
screen) is enough. A character who "stands still / stays in place / does not move" gives a frozen panel: write
"keeps a living idle" instead.

## What produces a round trip, and what to write instead
- one big single gesture (raise then lower the arms, stand up then sit down) -> an idle + a short repeated gesture,
  or a cyclic gesture ("keeps turning... always the same way");
- moving and staying in frame (walk toward, approach, cross then come back) -> a relay (the character leaves the frame
  and an identical one enters), or the character in idle while OTHERS pass by;
- "walk in place" -> an idle, the background scrolls as a flow;
- a change of state (fill, empty, stack, open a box, sign, put an object down, get dressed) -> a gesture that produces
  nothing final: tap, brush, leaf through;
- going through a door, entering then leaving by the same side -> enter on one side, leave on the other, replaced;
- a 90-degree camera ARC in a loop (the camera goes and comes back) -> a full orbit360, or a drag-controlled panel
  (arc / demi_arc + "fige", no loop);
- soft words: slowly, slow, tiny, small, calm, gently, stays in place -> "keeps ...", "again and again", "at a steady
  beat", "clearly visible";
- negations: never, not, without, no one, does not -> rephrase positively (H3 is distilled, without a negative prompt:
  it ADDS what you deny).
Also banned (project rules): costume, dolly, zoom, cinematic, film grain, 35mm, operator, cameraman. Never describe who
is filming.

## Writing the prompt (English, no negation)
A living panel normally uses camera "fixe" (the camera shake is added by the player: NEVER write it) and action
"custom" with "loop": true; the action field "text" is the sentence. Template:
"<Place>, <precise subject> keeps <rhythm or cycle gesture>, and keeps a living idle: breathing, blinking, the fabric
trembling. <Flow or relay engine with ONE direction: 'one after another', 'always the same way', 'leaving on the right
as the next arrives from the left'>. Everything is already in motion at the very first image and still in motion at
the very last image. The shot is one seamless forward cycle: each motion keeps flowing in the same direction or
repeats at a steady beat, and the last image is the first image again. The only sound is the natural sound of the
place: <sounds>."
Rules: loop verbs ("keeps ...", "again and again", "one after another", "round and round in the same direction", "at a
steady beat"); one or two strong verbs per character, everything else in idle; describe each character precisely
("the man in the pink quilted collar", never "he"), otherwise H3 mixes the subjects; the sounds you describe are the
ones H3 computes with the video (free foley); no dialogue in quotes; 5 seconds: do not tell a story, describe a state
that turns.

## Orbit 360
The camera always turns the same way and comes back naturally: the purest loop. The author wants AT LEAST ONE orbit per
page, in the LARGEST panel, with a very light idle of the subject: camera "orbit360", field "subject" = the precise
subject. To animate the subject: action "custom", loop true, text: "<Subject> keeps a living idle at the centre of the
orbit: breathing visibly, blinking, the fabric and the hair trembling. The orbit is already turning at the first image
and still turning at the last image, at one even speed all the way round."
Good orbit images: ONE subject, well detached from the background, full or half body, simple set (podium, studio,
empty room, plain wall). Avoid: crowds, subject cut at the frame edge, very busy sets, very tight face close-ups.

## Reading the image before writing
Find the possible engine in the image: steam, screen, bulbs, window in the rain, corridor with people passing at the
back, hands busy with a repetitive gesture, a spinning object, a flame, water. Good subjects: seated, leaning, busy,
waiting. Bad: in full swing, mid-gesture (H3 wants to finish the gesture). A crowd without an engine is the worst case
(frozen panel): add a flow (lights, screen, rain) or a relay at the back. Close-up faces: idle + light flow; if the
mouth speaks, the panel needs a voice.

## Voice and music
- If a character's mouth moves to speak (lip-sync), the panel NEEDS a voice, even if it says almost nothing. When the
  voice option is on, write one short French line said once per hover; otherwise say in "explain_fr" that this panel
  needs a voice-off (the author records his own short maxims as MP3 and loads them himself).
- One music per page (the page sound); foley and a few laconic lines in some panels only. Not every panel needs its
  own sound.

## After rendering: check, then repair without re-rendering when possible
- Measures: motion < 0.3 = frozen; mirror (video vs itself played backwards) < 0.55 with one excursion = ROUND TRIP;
  braking (speed of the first/last 12 frames vs the middle) < 0.5 = slows at the seam; seam jump > 3 = visible jump.
- Braking at the seam: repair with the edit-mode keys "ease" (play the slow frames faster) or "range" + "xfade". No
  re-render. Orbits always loop well but brake hard at the edges: "ease" fixes them.
- Round trip or frozen panel: NOT repairable. Re-render with another text (another engine) or another seed; after two
  failures change the engine (flow, relay, orbit) rather than insist.

## Examples to follow
- Relay + rhythm (dryers): "At the hair salon the women under the silver dryer hoods keep turning pages of their
  magazines; the man in the pale puffer and the man in the cream feather outfit keep nodding their heads under the
  dryers; the hairdresser keeps walking along the line and checking the curlers."
- Cycle + flow: "At the sink the man in the gold quilted outfit keeps turning a cup under the running tap, always in
  the same direction, the water pouring in a continuous stream; the man in the plaid shirt beside him keeps a living
  idle, breathing, blinking."
- Rhythm + flow (steam): "In the canteen the man in the pale pink quilted collar keeps stirring his coffee, the spoon
  going round and round in the same direction; steam keeps rising from the cup; the television on the wall keeps
  flickering; he keeps a living idle, eyes lowered, breathing."
- Relay alone (corridor): "In the green corridor two fidèles sit on the plastic chairs keeping a living idle; down the
  corridor a steady stream of crew members keeps coming toward us and passing out of the frame on the right while new
  ones keep appearing at the far end."

## Examples NOT to write
- "The man slowly raises his arm to greet her, then lowers it." -> guaranteed round trip (big gesture + "slowly").
- "He walks in place down the corridor." -> H3 moves the subject forward then back.
- "The woman stays in place and does not move." -> frozen panel ("stays in place", negation).
- "The camera arcs ninety degrees around the model." (looping) -> the camera comes back; use orbit360.
- "The cup fills with coffee." -> a changed state never comes back identical.

## Checklist for each living panel
1. Read the image: find the engine (flow, relay, cycle, rhythm).
2. Every character gets a living idle; at most one or two strong verbs per character.
3. At least one engine, with ONE direction or a steady beat, never "and comes back".
4. No state that changes (nothing fills, empties or ends).
5. End with the loop sentence ("Everything is already in motion at the very first image...").
6. Banned words: slowly, slow, tiny, small, calm, gently, stays in place, never, not, without, no one, costume, dolly,
   zoom, cinematic, operator.
7. Camera "fixe" (shake is in the player); no 90-degree arc in a loop; orbit360 for the largest panel of the page.
8. Sounds: "The only sound is the natural sound of the place: ..." (H3 computes them, free).
9. Voice: a mouth that speaks needs a voice (short French line, or flag it for the author's MP3). One music per page.
10. After rendering: check motion, mirror, braking, seam; repair braking with "ease" / "range"; re-render round trips
    and frozen panels with another engine.
11. Panels marked review "ok" (green) were validated by the author: NEVER change them.
