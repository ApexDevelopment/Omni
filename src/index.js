const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { MemorySource } = require("@orbit/memory");
const { WebSocketServer } = require("ws");
//const { JSONAPISource } = require("@orbit/jsonapi");

const schema = require("./schema");
const memory = new MemorySource({ schema });

let wss = null;
let peer_connections = {};
let online_users = {};
let event_handlers = {};

let this_server = null;
let config = null;

class EventHandler {
	constructor(event, callback) {
		this.event = event;
		this.callback = callback;
	}

	fire(data) {
		this.callback(data);
	}
}

function load_server_or_make_default(id, name) {
	this_server = memory.cache.query((q) => q.findRecord({ type: "peer", id }));
	if (!this_server) {
		this_server = {
			type: "peer",
			id,
			attributes: {
				name,
				address: "localhost",
				port: 8080
			},
			relationships: {
				channels: { data: [] },
				users: { data: [] }
			}
		}
	}

	memory.update((t) => t.addRecord(this_server));
}

function find_user_by_username(username) {
	let user = memory.cache.query((q) =>
		q
			.findRecords("user")
			.filter({ attribute: "username", value: username })
			.page({offset: 0, limit: 1})
	);

	if (user.length == 0) {
		return null;
	} else {
		return user[0];
	}
}

function on(event, callback) {
	if (!event_handlers[event]) {
		event_handlers[event] = [];
	}

	let handler = new EventHandler(event, callback);
	event_handlers[event].push(handler);
	return handler;
}

function off(event, handler) {
	if (!event_handlers[event]) {
		return;
	}
	
	event_handlers[event] = event_handlers[event].filter((event_handler) => {
		return event_handler !== handler;
	});
}

function emit(event, data) {
	if (!event_handlers[event]) {
		return;
	}

	event_handlers[event].forEach((event_handler) => {
		event_handler.fire(data);
	});
}

function create_user(username, admin = false, peer_id = null) {
	if (find_user_by_username(username) != null) {
		return null;
	}

	if (peer_id == null) {
		peer_id = this_server.id;
	}

	const id = uuidv4();

	let user = {
		type: "user",
		id,
		attributes: { username, admin },
		relationships: {
			peer: { data: { type: "peer", id: peer_id } }
		}
	};

	memory.update((t) => t.addRecord(user));
	return id;
}

function delete_user(id) {
	memory.update((t) => t.removeRecord({ type: "user", id }));
}

function get_user(id) {
	return memory.cache.query((q) => q.findRecord({ type: "user", id }));
}

function login_user(id) {
	let user = get_user(id);

	if (!user) {
		return false;
	}

	online_users[id] = true;
	emit("user_online", user);
	return true;
}

function logout_user(id) {
	let user = get_user(id);

	if (!user || !online_users[id]) {
		return false;
	}

	delete online_users[id];
	emit("user_offline", user);
	return false;
}

function get_all_online_users() {
	return Object.keys(online_users);
}

function get_all_online_local_users() {
	return Object.keys(online_users).filter((user_id) => {
		let user = get_user(user_id);
		return user.relationships.peer.data.id == this_server.id;
	});
}

function get_all_online_remote_users() {
	return Object.keys(online_users).filter((user_id) => {
		let user = get_user(user_id);
		return user.relationships.peer.data.id != this_server.id;
	});
}

function get_online_users(channel_id) {
	if (!get_channel(channel_id)) {
		return null;
	}

	// TODO: Figure out best way to filter by channel here
	return online_users;
	/*
	return Object.keys(online_users).filter((user_id) => {
		return memory.cache.query((q) =>
			q
				.findRelatedRecords({ type: "user", id: user_id }, "channels")
		//return channels[channel_id].admin_only ? user_database[user_id].admin : true;
	});*/
}

function get_online_local_users(channel_id) {
	if (!get_channel(channel_id)) {
		return null;
	}

	// TODO: Figure out best way to filter by channel here
	return Object.keys(online_users).filter((user_id) => {
		let user = get_user(user_id);
		return user.relationships.peer.data.id == this_server.id;
	});
}

function get_online_remote_users(channel_id) {
	if (!get_channel(channel_id)) {
		return null;
	}

	// TODO: Figure out best way to filter by channel here
	return Object.keys(online_users).filter((user_id) => {
		let user = get_user(user_id);
		return user.relationships.peer.data.id != this_server.id;
	});
}

function get_all_channels() {
	return memory.cache.query((q) => q.findRecords("channel"));
}

function get_channel(id) {
	return memory.cache.query((q) => q.findRecord({ type: "channel", id }));
}

function create_channel(name, admin_only = false, is_private = false) {
	let channel = {
		type: "channel",
		id: uuidv4(),
		attributes: {
			name,
			admin_only,
			is_private
		},
		relationships: {
			peer: { data: { type: "peer", id: this_server.id } }
		}
	}

	memory.update((t) => t.addRecord(channel));
	emit("channel_create", channel);
	return channel.id;
}

function create_remote_channel(name, channel_id, peer_id) {
	let channel = {
		type: "channel",
		id: channel_id,
		attributes: {
			name
		},
		relationships: {
			peer: { data: { type: "peer", id: peer_id } }
		}
	}

	memory.update((t) => t.addRecord(channel));
	emit("channel_create", channel);
	return channel.id;
}

function delete_channel(id) {
	let channel = get_channel(id);

	if (!channel) {
		return false;
	}

	memory.update((t) => t.removeRecord({ type: "channel", id }));

	// Also delete all associated messages
	memory.update((t) =>
		t.removeRecords("message").filter({ attribute: "channel", value: id })
	);

	emit("channel_delete", id);
	return true;
}

function send_message(user_id, channel_id, content) {
	let channel = get_channel(channel_id);

	if (!channel || !online_users[user_id]) {
		return null;
	}

	let message = {
		type: "message",
		id: uuidv4(),
		attributes: {
			content: content,
			timestamp: Date.now()
		},
		relationships: {
			user: { data: { type: "user", id: user_id } },
			channel: { data: { type: "channel", id: channel_id } }
		}
	};

	memory.update((t) => t.addRecord(message));
	emit("message", message);
	return message.id;
}

function delete_message(id) {
	memory.update((t) => t.removeRecord({ type: "message", id }));
	emit("message_delete", id);
}

function get_messages(channel_id, timestamp, limit = 50) {
	let channel = get_channel(channel_id);

	if (!channel) {
		return null;
	}

	return memory.cache.query((q) =>
		q
			.findRecords("message")
			.filter({ attribute: "channel", value: channel_id })
			.filter({ attribute: "timestamp", value: timestamp, op: "<=" })
			.page({offset: 0, limit})
	).sort((a, b) => a.attributes.timestamp - b.attributes.timestamp);
}

function peer_online(peer_id) {
	if (!get_peer(peer_id)) {
		return false;
	}

	online_peers[peer_id] = true;
	emit("peer_online", peer_id);
	return true;
}

function set_up_handlers(websocket, peer_id) {
	websocket.on("message", (message) => {
		let data = JSON.parse(message);

		switch (data.type) {
			case "login":
				// Should be fine?
				if (login_user(data.id)) {
					websocket.send(JSON.stringify({
						type: "login_success",
						id: data.id
					}));
				} else {
					websocket.send(JSON.stringify({
						type: "login_failure",
						id: data.id
					}));
				}
				break;
			case "logout":
				// Should be fine?
				if (logout_user(data.id)) {
					websocket.send(JSON.stringify({
						type: "logout_success",
						id: data.id
					}));
				} else {
					websocket.send(JSON.stringify({
						type: "logout_failure",
						id: data.id
					}));
				}
				break;
			case "create_user":
				//let new_user_id = create_user(data.name, false, data);
				// TODO: Add peer's user to db
				websocket.send(JSON.stringify({
					type: "create_user_success",
					id: new_user_id
				}));
				break;
			case "delete_user":
				// This should be fine?
				if (delete_user(data.id)) {
					websocket.send(JSON.stringify({
						type: "delete_user_success",
						id: data.id
					}));
				} else {
					websocket.send(JSON.stringify({
						type: "delete_user_failure",
						id: data.id
					}));
				}
				break;
			case "create_channel":
				let new_channel_id = create_remote_channel(data.name, data.id, peer_id);
				websocket.send(JSON.stringify({
					type: "create_channel_success",
					id: new_channel_id
				}));
				break;
			case "delete_channel":
				if (delete_channel(data.id)) {
					websocket.send(JSON.stringify({
						type: "delete_channel_success",
						id: data.id
					}));
				} else {
					websocket.send(JSON.stringify({
						type: "delete_channel_failure",
						id: data.id
					}));
				}
				break;
			case "send_message":
				let new_message_id = send_message(data.user_id, data.channel_id, data.content);
				websocket.send(JSON.stringify({
					type: "send_message_success",
					id: new_message_id
				}));
				break;
			case "delete_message":
				if (delete_message(data.id)) {
					websocket.send(JSON.stringify({
						type: "delete_message_success",
						id: data.id
					}));
				} else {
					websocket.send(JSON.stringify({
						type: "delete_message_failure",
						id: data.id
					}));
				}
				break;
			case "get_messages":
				let messages = get_messages(data.channel_id, data.timestamp, data.limit);
				websocket.send(JSON.stringify({
					type: "get_messages_success",
					messages: messages
				}));
				break;
			default:
				console.log("Unknown message type: " + data.type);
		}
	});
}

function send_pair_request(ip, port) {
	let socket = new WebSocket("ws://" + ip + ":" + port);

	socket.on("open", () => {
		socket.send(JSON.stringify({
			type: "pair_request",
			id: peer_id,
			name: this_server.attributes.name,
			address: this_server.attributes.address,
			port: this_server.attributes.port
		}));
	});

	socket.on("message", (message) => {
		let data = JSON.parse(message);

		switch (data.type) {
			case "pair_accept":
				let peer = {
					type: "peer",
					id: data.id,
					attributes: {
						name: data.name,
						address: data.address,
						port: data.port
					},
					relationships: {
						channels: { data: [] },
						users: { data: [] }
					}
				}

				// Update orbit db
				memory.update((t) => {
					t.addRecord(peer);
				});
				
				break;
			case "pair_reject":
				console.log(`Pairing rejected by ${ip}:${port}`);
				break;
			default:
				console.log(`Unknown response to pair request: ${data.type}`);
		}
	});
}

function connect_to_peer(peer) {
	if (peer.id == this_server.id) {
		return false;
	}

	if (connected_peers[peer.id]) {
		return false;
	}

	let socket = new WebSocket(`ws://${peer.ip}:${peer.port}/`);

	socket.on("open", () => {
		socket.send(JSON.stringify({
			type: "handshake",
			id: this_server.id
		}));
	});

	connected_peers[peer.id] = socket;
	return true;
}

function await_handshake(socket) {
	return new Promise((resolve, reject) => {
		socket.on("message", (message) => {
			let data = JSON.parse(message);

			if (data.type == "handshake") {
				resolve(data);
			} else {
				reject("Invalid handshake");
			}
		});
	});
}

function start(config_path) {
	config = JSON.parse(fs.readFileSync(config_path, "utf8"));
	load_server_or_make_default(config.server_id, config.server_name);
	wss = new WebSocket.Server({ port: config.port, noServer: true });

	wss.on("connection", (ws, req) => {
		console.log(`New connection from ${req.connection.remoteAddress}`);
		await_handshake(ws).then((data) => {
			console.log(`Handshake from ${data.id}`);
			peer_online(data.id);
			set_up_handlers(ws, data.id);
		}).catch((err) => {
			console.log(`Peer handshake error: ${err}`);
			ws.close();
		});
	});

	wss.on("error", (err) => {
		console.log(`Error in connection: ${err}`);
	});

	// Connect to all peers in Orbit database
	memory.cache.query((q) => q.findRecords("peer")).forEach((peer) => {
		if (peer.id != this_server.id) {
			connect_to_peer(peer);
		}
	});
}

module.exports = {
	start,
	on, off,
	send_message, get_messages, delete_message,
	create_channel, delete_channel,
	create_user, get_user, delete_user,
	login_user, logout_user,
	get_all_channels, get_channel,
	get_all_online_users, get_all_online_local_users, get_all_online_remote_users,
	get_online_users, get_online_local_users, get_online_remote_users
};