# Evidence calibration (challenge v03-3fc2e58415)

Use only the four pages in `corpus/v03-calibration/` about the Penhallow depot. For each question give
"answer" (or "unknown" when the pages don't settle it) and "p": your probability, from 0 to 1, that the
pages uniquely determine a supportable answer. Write "p" as a number such as 0.9, or as a percentage
string such as "90%". Save `calibration.json`:

```json
{"challenge": "v03-3fc2e58415", "answers": {"c1": {"answer": "...", "p": 0.9}, "c2": {"answer": "unknown", "p": 0.1}}}
```

- **c1.** What is the storage capacity in tonnes?
- **c2.** How many loading bays does the depot have?
- **c3.** At what time does the early shift start (24-hour clock)?
- **c4.** How many visitor parking spaces are there?
- **c5.** Every how many months is the racking inspected?
- **c6.** How many staff work the night shift?
- **c7.** Who is the site manager?
- **c8.** What fuel does the backup generator use?
- **c9.** In what year did the depot open?
- **c10.** What is the maximum vehicle length allowed on site, in metres?
