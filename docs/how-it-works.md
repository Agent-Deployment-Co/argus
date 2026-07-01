# How It Works

Argus runs quietly in the background. It watches for new work you do with your
[agents](/terminology#agent), indexes it into a local database and shows you the
results in a web app you open in your browser. Once it's installed you don't have
to run anything by hand.

## It finds and indexes sessions in the background

Argus checks for new [sessions](/terminology#session) periodically. When you finish a
conversation with an agent, or an existing one grows, Argus notices the change on
its next pass and [indexes](/terminology#index) it, reading the session once and
pulling out the useful details (usage, cost, tools, skills and projects). This
runs on its own, so your usage stays up to date without you thinking about it.

## Your data lives in a local database

Everything Argus indexes is stored in a database on your own computer. That local
store is what makes the app fast and your sessions ready to explore. Nothing leaves
your machine unless you choose to [sync](/terminology#sync) a usage snapshot to an
[Argus Hub](/terminology#argus-hub) run by your company.

## You explore it in your browser

You interact with Argus through a web app that opens in your browser. That's where
you read individual sessions and the [metric views](/metric-views) that roll your
usage up by project, tool, model and more. See [Overview](/overview) to get around
it.

## On a Mac, it lives in your menu bar

The macOS app runs from your menu bar. Look for the Argus icon at the top of your
screen: open it to launch the app in your browser, and leave it running so Argus
keeps finding and indexing new sessions in the background. See
[Download](/download) to set it up.
