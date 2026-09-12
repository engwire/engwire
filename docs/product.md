# Product

Engwire runs developer routines automatically, on the developer's own machine, triggered by the events that already interrupt them.

This document is the decision filter. When a build choice is not obviously right, it should be answerable from here. [architecture.md](architecture.md) describes what is implemented; this describes what is being built, and why.

## Thesis

**Vision.** Automate the engineering work around the code.

**Mission.** Run developer routines from engineering events — locally by default, with cloud coordination where it adds something local execution cannot.

**Positioning.** Local-first automation for engineering routines.

The current product is the local runtime. A cloud coordination layer, if justified, would sit alongside it for work such as event ingress or shared configuration. Moving execution itself requires a separate product and security decision; [Why local](#why-local) explains the tradeoffs. **Cloud** below names this possible capability, without committing to a service or account system.

## The wedge

**GitHub asks for your review → your coding agent starts reviewing it, on your machine, without anyone remembering to start it.**

The job: review requests arrive while the reviewer is doing something else. Engwire starts the reviewer's own agent on its own, so the author can act on a first pass before the human reviewer switches context.

That is the whole claim, and it is deliberately smaller than it sounds. Eligibility is narrower than "every request", too: authorization, fork status, draft state and skill preflight decide whether and when a request may run, and [architecture.md](architecture.md#invariants) owns those rules. Engwire does not promise the pull request merges sooner, that the reviewer's queue shrinks, or that the feedback is any good — it ships no review skill, so the value of a pass belongs to the skill its owner wrote. Human review remains human review.

Nor does it promise instant or exactly-once. Start time depends on polling, checkout, machine availability and one execution slot; a request made and withdrawn between two polls is never seen. Once the agent has been invoked, an interrupted run is terminal because Engwire cannot know whether it already posted. A graceful shutdown before invocation returns the claim to the queue. The guarantee is **automatic scheduling with at most one agent invocation per request**, on a pinned revision — see [architecture.md](architecture.md#invariants) for the full contract.

Claude Code is the only supported agent today.

## Why local

Not ideology, and not the pitch. The developer's code, tools, credentials, agent subscription, skills and configuration already live on their machine, and a routine that needs all of them runs best where they are:

- when the skill posts, it posts as the developer, following review instructions they wrote;
- it reaches private repositories without granting any new service access to source;
- it spends a subscription they already pay for, instead of a second per-seat bill;
- there is nothing to roll out — one engineer installs it without asking anybody.

**Local is a default, not a dogma.** Keep work local wherever proximity to the developer's code, tools, credentials or environment is what creates the advantage — that is a durable preference, not an implementation accident. Cloud is not the opposite of it, and not an escape hatch for when local fails: the two compose, and the useful question is which half of a routine each is good at.

Cloud can plausibly own **ingress and coordination**, alongside local execution rather than instead of it: event-driven ingress instead of polling, machine presence, shared routine configuration, run history a team can read. A webhook arriving at a queue and a laptop doing the work is the shape to expect.

That shape is not free, and the bill lands on the wedge's best argument. Receiving GitHub events means a hosted component GitHub is authorized to talk to: a new trusted party between the reviewer and their pull requests, where today there is none. What such a relay would actually have to be granted is unmeasured — [architecture.md](architecture.md#decisions) says the same, and it gets measured before a design leans on it either way. The party is the cost whatever the permission turns out to be, so Cloud never inherits the runner's trust proposition: any access it needs is justified on its own, to the same person who chose Engwire partly to avoid granting some.

What coordination does not by itself solve is **execution availability**. Buffering an event does not run an agent on a sleeping laptop, and waking one is a separate, platform-specific problem. The obvious alternatives are execution on an always-on machine the developer controls, or remote execution — and remote execution moves the credential, source-access and agent-account boundaries, which is precisely where this wedge's advantages live. What that would cost is a design question nobody has answered, so it is out of scope now and needs an explicit product and security decision before anyone reopens it. Treat it as an open bet, not a feature Cloud delivers.

Sell the outcome and explain the architecture second. Nobody buys "local-first"; they buy "when GitHub asks for my review, my agent starts."

## Who it is for

A developer who regularly receives GitHub review requests and already runs a coding agent seriously enough to have configuration and skills they trust.

Strengthening signals: several pull requests a week; review requests that land as interruptions; an agent in daily use; comfortable installing a CLI; private repositories that make a hosted reviewer awkward; wanting automation without another SaaS account.

There may be no buyer yet, and that is fine. Do not let a B2B pricing model arrive before an adoption model does.

## What this is up against

Automated PR review is a crowded category, and the incumbents have a structurally simpler install: authorize an app or add a CI integration, with no local runner to keep configured. Engwire will not win on convenience, and it certainly will not win on "we also use an LLM".

What it actually has:

- **Your skill and configuration, not a vendor-defined reviewer.** The pass runs review instructions you own and can rewrite this afternoon. A hosted reviewer's are its own, tunable as far as its settings go and no further. The model still has opinions of its own either way — what differs is who writes the instructions it follows.
- **No new access to source.** Engwire works through the GitHub credentials and the agent already on the machine, and no additional service is granted repository access. For a team whose policy stops at "no more vendors in the code", that is not a preference.
- **No second per-seat bill.** The subscription is already paid for.
- **It is built around execution, not review logic.** The thesis is that the same runtime carries other developer routines — a review bot would have to become a different product to do that, and this would not. That is the upside, not a fact yet: a second routine is what starts proving it.

Where it loses, plainly: a sleeping laptop reviews nothing, installing a CLI costs more than clicking a button, and the first pass is only as good as a skill the user has to own. The third is deliberate — see [The wedge](#the-wedge). The second is an installer problem worth grinding down. The first has no answer inside the thesis at all, which is why it is written up as an open bet under [Why local](#why-local) rather than filed as a Cloud feature.

CI- and hosted-agent approaches answer the same trigger from remote execution, including agents running the same CLI Engwire runs. The honest difference is whose configuration, whose credential and whose identity — not who has the better model. Which specific products do this is market research, and belongs there rather than here.

## What is being proved now

That developers install Engwire, leave it running, and repeatedly get feedback worth having — without remembering it is there.

Evidence, roughly in order of how hard it is to fake:

- **Activation** — a first genuinely automatic review on a real pull request.
- **Reliability** — eligible requests that reached a correct agent invocation with no human intervention.
- **Repeat** — the same person's second real run, then their fifth.
- **Retention** — still running at 7 and at 30 days.
- **Usefulness** — the author says the first pass was worth having.
- **Attention cost** — how often somebody had to nudge, fix or restart Engwire.

Aim for ten active external developers, and do not turn ten into a threshold. Five people on real repositories, running for weeks, who would notice its absence is stronger evidence than twenty one-time installs. What counts is unrelated developers, real repositories, repeated runs, continued use.

A north star worth growing into rather than crowning yet: **useful unattended routines per retained developer.**

## How the first users arrive

One founder, no budget, so distribution has to come out of the product rather than beside it.

The pain is searched literally — running an AI review without a GitHub App, without a CI job, or on repositories a vendor may not touch — and [`engwire.com/vs/github-actions`](https://engwire.com/vs/github-actions) is the shape that answers one of those. Write the page that names the exact workaround, not a category.

The skill is the on-ramp, and the awkward part of it. Engwire ships none by design, so a new user needs one before anything happens; `engwire/skills` exists to make that a copy rather than a project. Anything that shortens *skill in hand → first automatic review* is worth more than a feature.

The rest is unglamorous: be where developers already compare coding-agent setups, and watch for people saying out loud that review requests interrupt them — that sentence is the whole qualification. No paid acquisition until retention is understood, and no launch post until Engwire has shown sustained unattended use on a machine that is not this one. How long that takes is a launch checklist's business, not this document's.

## Two independent questions

Expansion has two axes, and they are not the same bet. Either can move first.

**Can another coding agent satisfy Engwire's execution contract?** Agent support is a contract, not a model name — [architecture.md](architecture.md#decisions) lists what one holds. Whether a materially different CLI can run unattended with isolated configuration, a pinned identity, no relative executable search path, a captured transcript, unambiguous exit semantics, cancellation and descendant cleanup is unmeasured.

Split that into two pieces of work with different gates. **Measuring** one materially different CLI against the contract is cheap and belongs in [experiments.md](experiments.md), but it is still work: do it when the result can change a product or architecture decision that is actually open — or once the wedge is running reliably for external users, when what it answers is whether "runtime over developer-owned agents" is an asset or a story. **Shipping** an adapter is not cheap: it is permanent verification surface for a solo maintainer, and passing the execution contract earns support, never product value. So an adapter waits for a reason of the same kind the second routine needs — someone who would use Engwire and cannot, or a deliberate decision to spend on the runtime thesis with eyes open. "Otherwise we are just a Claude Code daemon" is an argument for the measurement, not for the adapter.

**Which second routine is repeatedly demanded?** Candidates share the wedge's shape — an engineering event a developer would otherwise answer by hand: CI failed → investigate; issue assigned → prepare context; dependency alert → inspect. Let demand identify the candidates, then prefer the smallest one that exercises the same local-first advantage while testing a genuinely reusable part of the runtime — repeated demand for something that gains nothing from running locally, or needs a different authority model, is not automatically routine number two. If the strongest demand keeps landing outside the thesis, that is evidence about the thesis rather than a routine to force into it. One routine is a feature; two similar routines are the first evidence that a workflow abstraction exists.

Neither answer needs the other. A second agent can land before a second routine.

## Not scope now

- **Public workflow or plugin APIs.** The runner loads no workflows or plugins, and the file format that exists is experimental — see [explorations/extensions.md](explorations/extensions.md).
- **Extension discovery or distribution infrastructure**, including a workflow directory or marketplace. None is on the roadmap; changing the name does not make it current scope.
- **Hosted coordination infrastructure** built for a routine nobody has asked for.
- **Scoring people.** No reviewer scorecards, no developer leaderboards, no cycle-time metrics attributed to individuals. Operational identity and run history may exist where running the product needs them; visibility of outcomes must never become measurement of people.

## Money

Open on purpose, with a leading hypothesis rather than a plan. The runner is MIT-licensed and free. That does not decide the monetization model, but it is a durable constraint on one: anything shipped can be forked, redistributed, bundled or hosted by somebody else, and no later decision takes that back.

**A — open runner, paid Cloud.** Best fit with the thesis. Blocked on finding a Cloud job real enough to pay for, and the candidates are coordination rather than execution: event-driven ingress instead of polling, machine presence, shared routines, run history a team can read.

**B — paid individual product.** Simplest to charge for, weakest willingness to pay. The developer already pays for the agent, and a second personal subscription for a scheduler is a hard sell.

**C — team control plane.** Shared routines, policy, audit, machine fleet, rollout. The clearest budget, and unbuildable before team pull exists.

The bias is **A → C**, and the strongest argument against all three deserves saying out loud: **the wedge selects exactly the people hardest to charge.** Someone chooses Engwire because there is no SaaS account, no second bill, and no vendor holding repository access — and every monetization above asks them to accept one of those. The buyer with a budget may reasonably prefer a hosted reviewer instead, which is a smaller ask of them than of the developer who installed this.

So a second teammate installing the runner is a signal to go and ask, not a trigger to build. Before anything commercial is built there has to be a named buyer, a coordination problem they describe in their own words, and either money or a paid-pilot commitment. Until that exists: no metering, no entitlements, no pricing page, and no Cloud service standing by for it.

## What would change direction

These are prompts to go and find out why, not verdicts. Every one of them has a boring explanation as well as a strategic one, and the boring one is usually right first.

- **Nobody keeps it running past week one.** Ask whether setup defeated them, whether it broke, or whether the runs were fine and they simply did not care. Only the third is a wrong wedge; the first two are bugs.
- **The first pass is reliably ignored.** Check timing before quality: this product polls and runs one review at a time, so a good pass that lands after the human review was late, not useless. Diagnose polling, queueing, checkout and machine availability before judging the wedge — and be honest that one of those may turn out to be structural rather than a bug. Then check whose skill ran, since a thin skill is a distribution problem and Engwire ships none on purpose. Only when a good skill arrives in time and is still ignored has the value turned out not to be here.
- **A second agent turns out to need a different execution model entirely.** Then "runtime over developer-owned agents" is a story rather than an asset, and Engwire is a very good Claude Code companion — which is allowed, and changes what to build next.
- **Teams ask before individuals do.** Interesting, and not yet a mandate. Go and find out what those teams cannot do today, then run it through the same gate as anything commercial — a named buyer, a coordination problem in their words, and money or a paid pilot. Only that reorders A and C; a team asking about Engwire is not a reason to build machine presence.

One observation that is *not* a pivot signal, despite looking like one: someone using Engwire on a single repository. Plenty of engineers work in one repository, and repeated automatic runs there are the wedge working. What would matter is repeated runs producing nothing anyone acts on.

Do not change direction because a competitor shipped a feature.

## Decision rules

- **Design authority and security boundaries before execution; generalize behavior only after repeated need.** Absolute YAGNI is wrong for a boundary that is expensive to retrofit, and right for everything above one.
- **Do not build a platform capability for a hypothetical routine.** Prefer a concrete second routine over a reusable abstraction until repeated implementation proves the abstraction. The inert artifacts already here — the plugin entry point, the workflow schema — may stay as design evidence, but they earn no production behavior, no compatibility obligation and no new API surface until a real routine asks.
- **Agent support is earned per CLI, and measurement is only part of the price.** External CLI behaviour is measured, the boundaries Engwire controls are tested, and the adapter is implemented and maintained. Access to a model is not support, and neither is a passing experiment.
- **Claims about external systems get measured** into [experiments.md](experiments.md), never assumed.
- **Unattended reliability beats features.** A routine that needs attention is not a routine.

## Scope of hosted work

A change that only makes sense as groundwork for another hosted product is out of scope. Any coordination layer considered here must earn its place through runner users' needs and the product and security decisions described under [Why local](#why-local).
