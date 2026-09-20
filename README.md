# Inspiration

We started with a fairly serious question:

> **What would it look like if AI agents lived within a city simulation?**

Most city simulators reduce people to statistics - population, traffic, happiness, demand. You can watch a neighborhood become congested or a station become overcrowded, but the people themselves are mostly abstract.

Most AI systems have the opposite problem. They can reason, converse, plan, and react, but usually only from the outside. You ask a model what *should* happen, it gives you an answer, and that is where the world ends.

We wanted to connect those two ideas.

**What if the people inside the simulation could actually think?**

What if they could:

* perceive what was happening around them
* form their own opinions
* talk to one another
* trust some people more than others
* make decisions based on what *they* know
* and then physically act on those decisions inside the world

That started with fairly practical scenarios: evacuations, transit failures, road closures, emergency response, and resource allocation.

But once we had a system where agents could react to arbitrary changes in the world, it became hard not to ask increasingly stupid questions.

> “What if a tornado hits downtown during rush hour?”

> “What if every bridge suddenly closes?”

> “What if two groups are given conflicting orders?”

> “What if we just orbital strike this intersection?”

So we added earthquakes, tornadoes, riots, orbital strikes, and a natural-language interface that lets you describe scenarios directly to the city.

God’s Plan ended up somewhere between a **multi-agent simulation platform** and a **god game**.

That turned out to be exactly what we wanted.

---

# What it does

God’s Plan is a living city populated by **thousands of autonomous residents**.

Each resident exists as an individual agent with its own:

**context → observations → goals → relationships → allegiances → internal state**

They can move around the city, talk to other residents, enter vehicles, use tools, fight, flee, cooperate, follow others, and respond to events as they unfold.

The important part is that **they are not all following one central script**.

An agent only knows what it has access to.

Someone standing beside an accident may understand what happened immediately. Someone five blocks away might only hear about it from another resident. Another agent might receive an instruction from its group and act before either of them.

That means two residents can experience the same city very differently.

We built a **dynamic relationship and allegiance system** around this. Agents can belong to groups, develop sentiment toward other agents or factions, trust certain sources more than others, and let those relationships influence what they do next.

A resident might take the obvious evacuation route.

Another might turn around because somebody they care about is still behind.

A third may ignore both of them because their group has been ordered to secure the area.

None of those decisions need to come from a single central controller.

## Swarms

Agents can also operate as part of larger **swarms** with shared responsibilities or objectives.

A swarm might represent:

* civilians trying to evacuate
* emergency responders
* police
* hostile groups
* transportation operators
* rescue teams
* or essentially any population we define

Different swarms can be backed by different model providers - **GPT, Claude, Gemini, Grok, and others** - while still existing inside the exact same simulated world.

So rather than asking four models the same question in four separate chat windows, we can put them into the same environment and let their decisions affect one another.

> **One model's decision becomes another model's problem.**

The swarm gives agents higher-level direction, but the individuals inside it still respond to their own local circumstances.

That distinction became very important to us.

**The swarm has a goal.
The agent still has a life.**

## Talk directly to the world

You interact with God’s Plan through natural language.

You can type:

> “Evacuate everyone north of downtown.”

or:

> “Police should secure the bridge while civilians move west.”

or:

> “A magnitude 7 earthquake just hit the city.”

The system translates that instruction into objectives, events, or changes to the simulation, and then lets the agents respond.

You are not manually selecting every resident and telling them where to walk.

You change the situation.

**The city figures out what happens next.**

## Click into anyone

One of our favorite features is that at any point, you can click into an individual resident.

From above, they might just look like one person in a crowd of hundreds.

Click them and you can inspect things like:

> **What do they currently know?**
> What are they thinking about?
> Who do they trust?
> What groups are they aligned with?
> How do they feel about what is happening?
> What are they trying to do next?

That made the large-scale behavior of the simulation much more interesting to us.

You might look at the city and wonder why a crowd is moving the “wrong” direction.

Then you click into one of them and discover that somebody told the group a bridge was blocked.

Or that they are following somebody they trust.

Or that one resident is trying to get back to someone who was left behind.

From far away, it looks like crowd movement.

Up close, it is thousands of small decisions colliding.

---

# How we built it

At the center of God’s Plan is a fairly simple idea:

> **Perceive → Think → Act → Observe → React**

The complexity comes from running that loop across a large shared world.

## 1. Perceive

Agents do not receive omniscient access to the entire simulation.

They are given a bounded view of what is relevant to them:

* nearby agents
* visible events
* objects they can interact with
* messages they have received
* their current location
* group objectives
* relationships and allegiances
* relevant memories and recent events

This means an agent's decisions depend on what **that agent** knows, not what the simulation knows globally.

## 2. Think

The model reasons over that context together with the agent's goals, state, and relationships.

For example:

> “The evacuation route is blocked.”

> “My group is moving east.”

> “Someone I trust is still behind me.”

> “There is a vehicle nearby.”

Different agents can reach completely different conclusions from the same event because they have different information and priorities.

## 3. Act

Models do not directly modify the world.

Instead, they select from a structured set of tools exposed by the simulation.

Depending on the agent and situation, those actions can include things like:

**move → inspect → communicate → follow → enter vehicle → drive → interact → attack → defend**

This boundary is important.

A model can decide:

> “I should take that car and get out of here.”

But it cannot simply declare:

> “I escaped.”

There has to actually be a car.

The agent has to reach it.

It has to enter successfully.

The route ahead still has to exist.

And if someone else took the car first, that becomes part of the next decision.

**The model provides intention.
The simulation provides reality.**

## 4. Observe and react

After acting, agents receive the result back from the world.

Plans can fail.

Conditions can change.

Other agents can interfere.

The tornado that was nowhere near you thirty seconds ago may now be blocking the route you planned to use.

The agent then reasons again using the updated state.

That gives us a continuing feedback loop instead of a one-shot prompt.

---

## Social state

Alongside the physical world, we maintain a **dynamic social graph** across the population.

Agents can have changing:

* relationships
* group membership
* allegiance
* trust
* sentiment
* shared history

These variables become additional inputs into future decisions.

So the “best” action for an agent is not always the geometrically shortest route or globally optimal plan.

Their behavior can also depend on **who is asking, who is nearby, and what has happened between them before**.

At a higher level, swarms provide shared context and objectives while preserving the local decision-making of their individual agents.

That gives us two interacting scales:

> **Swarm-level coordination**
> ↓
> **Individual agent decisions**
> ↓
> **World consequences**
> ↓
> **New information for the swarm**

---

## The simulation underneath it

The rest of God’s Plan ties that agent layer into an actual city.

Our backend is built around **Python, FastAPI, and Pydantic**, which we use to keep scenarios, agent state, actions, events, restrictions, and simulation data structured.

For transportation, we use **SUMO + TraCI** so vehicles and routes are governed by an actual traffic simulation rather than arbitrary animation.

The frontend is built with **React, TypeScript, Zustand, and Babylon.js**, rendering the world as an explorable 3D city.

We combine real street geography with Toronto building data and custom geometry so the agents are operating inside a recognizable environment rather than an abstract grid.

That also means events can affect the systems underneath the visuals.

A destroyed road can become inaccessible.

A blocked route can force replanning.

A vehicle can actually be occupied.

A crowd can genuinely accumulate because hundreds of agents independently chose the same place.

The disasters are fun to watch, but they are much more interesting when the simulation actually has to live with them.

---

# Challenges we ran into

## Giving agents freedom without giving them magic

A language model can very easily say:

> “I get into the car and drive across the city.”

A simulation has to care about everything hidden inside that sentence.

Is there a car nearby?

Can the agent reach it?

Is it already occupied?

Can the agent use it?

Is there a route to the destination?

Did somebody destroy that route twenty seconds ago?

A lot of our work became figuring out how to preserve the flexibility of language-model reasoning while forcing actions through the constraints of the simulated world.

---

## Scaling beyond a handful of chatbots

Thousands of autonomous residents create a very different problem from running five agents in a workflow.

We obviously cannot have every resident continuously sending expensive model requests just to decide whether they should keep walking down the sidewalk.

We had to think carefully about:

**when an agent needs to think → what can remain deterministic → what state should persist → what events should wake an agent back up**

That became one of the most interesting architectural problems in the project.

---

## Making everyone feel different

If a thousand residents receive the same information, have the same goals, and run the same prompt, you mostly get a thousand copies of one person.

That was not what we wanted.

Agents needed different information, relationships, priorities, positions in the world, and histories.

Once those differences started influencing decisions, the population became much less predictable.

It also became considerably harder to debug.

---

## Making chaos affect more than the screen

It is surprisingly easy to make a cool-looking tornado.

It is harder to make everyone else care.

We wanted events to feed back into the exact same state agents use when making decisions.

A disaster should be able to affect:

> roads → movement → access → information → behavior → group decisions

Otherwise the city can visually experience the apocalypse while everyone calmly continues their morning commute.

---

# Accomplishments that we're proud of

The part we are most proud of is that God’s Plan works at **two completely different scales**.

Zoom out and you can watch a whole city.

You see crowds form, vehicles move, groups coordinate, routes collapse, and thousands of residents respond to the same evolving situation.

Then you click one person.

The simulation suddenly becomes much smaller.

You can see what they know, what they are worried about, who they are aligned with, and why they are doing something that might look completely irrational from above.

That changed what we wanted the project to be.

We did not just want convincing crowd behavior.

We wanted the large-scale behavior to come from decisions that still made sense when you inspected the individuals producing it.

We're also proud that natural language became an interface to the **world itself**.

Instead of asking:

> “What might happen if downtown lost power?”

you can tell God’s Plan:

> “Downtown just lost power.”

And then let the simulation answer.

Underneath that is a system connecting model reasoning, tools, relationships, group behavior, geographic data, transportation simulation, dynamic events, and 3D visualization.

Our original transportation architecture already treated AI output as a proposal that still had to survive structured validation and actual simulation rather than accepting the model's prediction as reality.

We carried that same principle into the agents themselves.

**They can decide what they want to do.
They still have to live in the world afterward.**

---

# What we learned

The biggest thing we learned was how much more interesting multi-agent systems become once their agents genuinely share an environment.

If you ask GPT, Claude, Gemini, and Grok the same question independently, you get four different answers.

That can be useful.

But it becomes a very different experiment when:

> Claude makes a decision
> ↓
> that changes the environment
> ↓
> which changes what GPT sees
> ↓
> which causes another group to react
> ↓
> which changes the situation again

At that point, the interesting thing is no longer the response from any individual model.

It is the **interaction between them**.

We also learned that individually reasonable behavior can create very unreasonable collective outcomes.

Nobody has to decide to create a traffic jam.

Hundreds of agents can independently choose the same sensible route and create one.

Nobody has to decide to cause panic.

Information spreading through residents, changing relationships, and local observations can create something that looks surprisingly similar.

Those emergent outcomes became some of the most interesting moments in the project precisely because we did not directly script them.

And on the less serious side, we learned that giving people a detailed city simulation and an unrestricted text box does not encourage responsible urban planning for very long.

That was roughly how the orbital strike happened.

---

# What's next for God’s Plan

The part we want to push furthest is **persistent social behavior**.

Right now, agents can exist inside groups and maintain relationships and sentiment.

We want those structures to become increasingly organic over time.

Instead of spawning a predefined faction, agents could:

**meet → cooperate → form a group → choose leadership → develop loyalties → disagree → split apart**

We want memory, beliefs, reputation, and relationships to accumulate across longer simulations so that what happened an hour ago can still matter later.

We also want the natural-language interface to become much more expressive.

The long-term idea is that almost any experiment should begin with:

> **“What if...?”**

What if the subway shuts down after a concert?

What if every bridge closes?

What if half the city loses power?

What if two groups disagree about how an evacuation should happen?

What if one district is coordinated by Claude and another by GPT?

What if all of that is happening and then a tornado arrives?

Some of those questions have legitimate applications in transportation, emergency planning, crowd behavior, and multi-agent research.

Some are mostly an excuse to watch a tiny city descend into chaos.

The same underlying system makes both interesting.

God’s Plan started because we wanted to see what would happen if AI agents stopped reasoning about a world from the outside and instead had to exist **inside one** - surrounded by other agents, incomplete information, physical constraints, relationships, and the consequences of their own decisions.
