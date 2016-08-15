# node-fast2: streaming JSON RPC over TCP

This is version 2 of the [node-fast](https://github.com/mcavage/node-fast)
client library.  Fast is a simple RPC protocol used in Joyent's
[SmartDataCenter](http://github.com/joyent/sdc) and
[Manta](https://github.com/joyent/manta) systems, particularly in the
[Moray](https://github.com/joyent/moray) key-value store.  This README contains
usage notes.  For developers, see CONTRIBUTING.md.

Despite the name, this module contains an implementation of the protocol version
**1** (it's just a new implementation).  The module includes:

* client library interface
* server library interface
* `fastcall`, a command-line tool for making Fast RPC requests
* `fastserve`, a command-line Fast server for demo and testing
* `fastbench`, a command-line tool for very basic client load generation

This rewrite was done to fix a number of issues with service discovery and
connection management in the previous node-fast client.  Service discovery and
connection management in this client are managed by the caller using something
like [cueball](https://github.com/arekinath/node-cueball).

The library interfaces here follow Joyent's [Best Practices for Error
Handling](https://www.joyent.com/developers/node/design/errors).  In particular,
all operational errors are emitted asynchronously.  It is a programmer error to
call any of the public APIs with missing or incorrectly-typed arguments.  All
arguments are required unless otherwise specified.


## Synopsis

Start the Fast server:

    $ fastserve 2030 > server.log &

Use `fastcall` to invoke the `date` RPC method inside the client:

    $ fastcall 127.0.0.1 2030 date '[]'
    {"timestamp":1457475515355,"iso8601":"2016-03-08T22:18:35.355Z"}

Or try the `yes` method, an RPC version of yes(1):

    $ fastcall 127.0.0.1 2030 yes '[ { "value": { "hello": "world" }, "count": 3 } ]'
    {"hello":"world"}
    {"hello":"world"}
    {"hello":"world"}

For an example client and server, see the [fastcall](bin/fastcall) and
[fastserve](bin/fastserve) programs.


## Caveats

The Fast protocol is intended for internal systems.  It does not support
authentication.  Neither the client nor server implementations are hardened
against byzantine behavior (e.g., denial-of-service attacks), though they are
expected to correctly handle all network-related failure modes and byzantine
input.

Previous implementations of the Fast protocol supported cancellation, but it was
dangerous to use with servers that did not support it, and there was no way to
tell if the server did support it.  As a result, this implementation does not
support cancellation of in-flight requests.  (There's an `abort()` function in
the client API, but it only causes the request stream to fail.  The underlying
RPC continues executing and incoming messages are ignored.)

Early versions of the original node-fast module used a
[buggy](https://github.com/alexgorbatchev/node-crc/issues/29) CRC
implementation.  Since changing the CRC algorithm would require a flag day among
deployed components, this module continues to use the buggy CRC implementation.


## Observability

### Kang server

The Fast client and server provide functions suitable for use with
[kang](https://github.com/davepacheco/kang), a small library for exposing
debugging information over an HTTP API.

The server-side kang functions report:

* server-wide statistics about connections created, requests started,
  requests completed, and requests failed;
* per-connection state information (including time accepted and errors seen) and
  statistics about requests started, completed, and failed; and
* per-request state information (including time started)

These enable basic monitoring of server activity and health.  The connection and
request state information allows you to see which clients are connected, how
long they've been connected, and how long individual requests have been running,
which is often helpful in identifying leaked or hung requests.

The client-side kang functions report per-client and per-request state and
statistics.

The client and server only provide functions; you have to hook this up to a kang
server.  The built-in demo server ("fastserve") and benchmarking tool
("fastbench") demonstrate how to do that.

### DTrace probes

The Fast client and server provide DTrace probes and scripts in the "bin"
directory that use these probes to show client and server activity.  **These
scripts, the probes, and their arguments may change over time.**

**Fast client probes:**

Probe name  | Event                                            | Arg0                    | Arg1                     | Arg2                     | Arg3
----------- | ------------------------------------------------ | ----------------------- | ------------------------ | ------------------------ | ----
`rpc-start` | Client begins issuing an RPC call                | (int) Client identifier | (int) Message identifier | (string) RPC method name | (json) object with "rpcargs" and optional "timeout".
`rpc-data`  | Client receives 'data' event for outstanding RPC | (int) Client identifier | (int) Message identifier | (json) Received data     | -
`rpc-done`  | Client finishes processing RPC                   | (int) Client identifier | (int) Message identifier | (json) May contain "error" describing any error that occurred. | -

**Fast client scripts in "bin" directory:**

* fastclatency: trace latency of all client RPC requests.  Prints power-of-two
  histogram of request latency when the script exits.
* fastcsnoop: dump out client RPC activity (all "start", "data", and "done"
  events).

Note that the client identifier is only unique within a process, and the
message identifier is only unique for a given client.  Both are only unique
over a given period of time (i.e., client ids and message ids may be reused).
See the sample scripts for how to use these correctly.

**Fast server probes:**

Probe name     | Event                                            | Arg0                    | Arg1                     | Arg2                     | Arg3
-------------- | ------------------------------------------------ | ----------------------- | ------------------------ | ------------------------ | ----
`conn-create`  | Client connection created                        | (int) server identifier | (int) client identifier  | (string) client label    | -
`conn-destroy` | Client connection destroyed                      | (int) server identifier | (int) client identifier  | -                        | -
`rpc-start`    | Server starts processing an RPC call             | (int) server identifier | (int) client identifier  | (int) request identifier | (string) RPC method name
`rpc-done`     | Server finishes processing an RPC call           | (int) server identifier | (int) client identifier  | (int) request identifier | -

**Fast server script in "bin" directory:**

* fastssnoop: dump out server RPC activity (client connection create/destroy and
  rpc start/done).

Similar to the client, the server identifier is only unique within the process,
and the request identifier is only unique within the client.  See the sample
scripts for how to use these correctly.

The client and server also use bunyan for logging.  On systems with DTrace
support, you can use runtime log snooping (`bunyan -p`) to observe what the
client and server would be logging at the finest-grained log levels, even if you
haven't enabled those.


## Client API

Consumers of the client API are responsible for maintaining persistent
connections to the server.  The
[cueball](http://github.com/arekinath/node-cueball) module is recommended for
this purpose.  Clients pass connected sockets to the FastClient constructor:


### FastClient class

A FastClient attaches to a Node `net.Socket` object.  The FastClient makes RPC
calls by sending Fast messages over the socket and reading responses in the
form of Fast messages from the socket.

Constructor arguments:

Name              | Type         | Meaning
----------------- | ------------ | -------
`log`             | object       | [bunyan](https://github.com/trentm/node-bunyan)-style logger
`transport`       | `net.Socket` | underlying TCP connection to the server
`nRecentRequests` | positive int | number of recent requests to track for debugging purposes

While consumers are responsible for handling socket errors, the FastClient will
watch the `transport` for `error` and `end` events in order to proactively fail
any outstanding requests.

Public methods:

* `rpc(args)`: initiate an RPC request
* `request.abort()`: abort an RPC request
* `detach()`: detach client from underlying socket

This class emits `error` when there's a problem with the underlying socket
(other than an `error` emitted by the socket itself) that prevents any requests
from completing.  This would usually be a protocol error of some sort.


#### rpc(args): initiate an RPC request to the remote server

Named arguments:

Name            | Type         | Meaning
--------------- | ------------ | -------
`rpcmethod`     | string       | name of the RPC method to invoke on the server
`rpcargs`       | array        | JSON-serializable array of RPC call arguments
`timeout`       | integer      | (optional) milliseconds after which to abort the request if it has not already completed.  The default is that there is no timeout.
`log`           | object       | (optional) bunyan logger for this request.  If not specified, a child logger of the client-level logger will be used.

The return value is an object-mode stream that consumers use to interact with
the request.  Objects sent by the server to the client are made available via
this stream.  The stream emits `end` when the server successfully completes the
request.  The stream emits `error` when the server reports an error, or if
there's a socket error or a protocol error.  Consumers need not proactively
abort requests that fail due to a socket error.

As with other Node streams, the request stream will emit exactly one `end` or
`error` event, after which no other events will be emitted.

#### request.abort(): abort an RPC request

Clients may invoke `abort()` on the return value from `rpc(args)` to abort the
request.  If the request is not yet complete, then it will emit an `error`
indicating the abort, and no more data will be emitted.

This does not actually notify the server.  The server will still process the
request.  Future implementations may attempt to improve this by asking the
server to abort the request (though it will still be best-effort, since the
request may have already completed).


#### detach(): detach client from underlying socket

This method causes the client to stop sending data on the socket and stop
reading from the socket.  Any outstanding RPC requests are failed as though the
socket had emitted an `error`.


## Server API

### FastServer class

Each `FastServer` instance wraps a `net.Socket` _server_ socket.  The server
keeps track of clients connected to it.

Named arguments for the constructor:

Name            | Type         | Meaning
--------------- | ------------ | -------
`log`           | object       | [bunyan](https://github.com/trentm/node-bunyan)-style logger
`server`        | `net.Socket` | underlying server socket

Public methods:

* `registerRpcMethod(args)`: register an RPC method handler
* `rpc.connectionId()`: returns a unique identifier for this connection
* `rpc.requestId()`: returns a unique identifier for this request
* `rpc.methodName()`: returns the client-specified name of this request
* `rpc.argv()`: returns the array of arguments provided by the client for the
  request
* `rpc.fail(err)`: report failure of the RPC request with the specified error
* `close()`: shut down the server

#### registerRpcMethod(args): register an RPC method handler

Registers a JavaScript function to invoke for incoming RPC requests.  Named
arguments include:

Name            | Type         | Meaning
--------------- | ------------ | -------
rpcmethod       | string       | name of the method, as clients will specify it when making RPC calls
rpchandler      | function     | JavaScript function to invoke for each incoming request

The RPC handler function will be invoked as `rpchandler(rpc)`, where `rpc` is an
RPC context object.  This is a function-oriented interface for accessing
information about the RPC, including the request identifier, method name,
and arguments (see above).

The `rpc` object is an object-mode stream that the handler can use to emit
values and report request completion.  Values are sent to the client by writing
them to the stream.  Flow control is supported, provided the handler follows
conventions for that (i.e., using `pipe()` or checking the return value of
`write()`).  When the request has completed, the handler should end the stream
with its `end()` method.

The handler should report failure by invoking `rpc.fail(err)`, where `err` is an
error describing the failure.  The handler should not emit data or end the
request gracefully after reporting an error.

#### close(): shut down the server

This method shuts down the server by disconnecting outstanding requests from
their underlying connections and then destroying those underlying client
sockets.  **The consumer should close the underlying server socket first in
order to ensure no new connections will be created.  Any newly-created
connections will be dealt with, but without closing the server socket, there is
no guarantee that this process will converge.**

Since the interface for RPC handlers does not currently provide a way to inform
those handlers that the request has been cancelled because of a case like this,
handlers for outstanding requests continue as normal, and any data emitted is
ignored.  As a result, though, these handlers may continue running even after
this function has been called and client sockets are destroyed.


## Protocol overview

The Fast protocol is intended for use with TCP.  Typically, a Fast server
listens for TCP connections on a well-known port, and Fast clients connect to
the server to make RPC requests.  Clients can make multiple connections to the
server, but each connection represents a logically separate client.
Communication between client and server consist of discrete _messages_ sent over
the TCP connection.  Each message contains:

Field  | Type           | Purpose
------ | -------------- | -------
msgid  | 32-bit integer | identifies messages related to a given request
status | 8-bit integer  | indicates what kind of message this is
data   | raw JSON data  | depends on message status

Messages have headers that include additional information, like payload length
and checksum.  The physical format is described in detail in
[lib/fast_protocol.js](lib/fast_protocol.js).

There are three allowed values for `status`:

Status value | Status name | Description
-----------: | ----------- | -----------
`0x1`        | `DATA`      | From clients, indicates an RPC request.  From servers, indicates one of many values emitted by an RPC call.
`0x2`        | `END`       | Indicates the successful completion of an RPC call.  Only sent by servers.
`0x3`        | `ERROR`     | Indicates the failed completion of an RPC call.  Only sent by servers.

For all messages, the `data` field contains properties:

Field    | Type              | Purpose
-------- | ----------------- | -------
`m`      | object            | describes the RPC method being invoked
`m.name` | string            | name of the RPC method being invoked
`m.uts`  | number (optional) | timestamp of message creation, in microseconds since the Unix epoch
`d`      | object or array   | varies by message status

In summary, there are four kinds of messages.

**Client initiates an RPC request.** The client allocates a new message
identifier and sends a `DATA` message with `data.m.name` set to the name of the
RPC method it wants to invoke.  Arguments are specified by the array `data.d`.
Clients may issue concurrent requests over a single TCP connection, provided
they do not re-use a message identifier for separate requests.

**Server sends data from an RPC call.**  RPC calls may emit an arbitrary number
of values back to the client.  To emit these values, the server sends `DATA`
messages with `data.d` set to an array of non-null values to be emitted.  All
`DATA` messages for the same RPC request have the same message identifier that
the client included in its original `DATA` message that initiated the RPC call.

**Server completes an RPC call successfully.** When an RPC call completes
successfully, the server sends an `END` event having the same message identifier
as the one in the client's original `DATA` message that initiated the RPC call.
This message can contain data as well, in which case it should be processed the
same way as for a DATA message.

**Server reports a failed RPC call.**  Any time before an `END` message is
generated for an RPC call, the server may send an `ERROR` message having the
same message identifier as the one in the client's original `DATA` message that
initiated the RPC call.

By convention, the `m` fields (`m.name` and `m.uts`) are populated for all
server messages with the name of the RPC method being invoked, even though
`m.name` is redundant.

The RPC request begins when the client sends the initial `DATA` message.  The
RPC request is finished when the server sends either an `ERROR` or `END` message
for that request.  In summary, the client only ever sends one message for each
request.  The server may send any number of `DATA` messages and exactly one
`END` or `ERROR` message.
