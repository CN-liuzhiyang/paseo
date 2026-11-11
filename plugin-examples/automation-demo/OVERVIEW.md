Echoes a configured message when an event arrives or a clock fires. The demo registers
`demo.echo`, the `demo:ping` event and the `demo-results` delivery channel. Its `emit`
RPC accepts a stable event ID; `deliveries` returns captured results. Deliveries emit
a causally linked ping so you can verify loop prevention.

Requires the host's automation extension points. On older hosts it starts without
registering them. Parameters and emitted data are examples, with no external service.
