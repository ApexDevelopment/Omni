const fs = require("fs");
const ip6addr = require("ip6addr");
const { v4: uuidv4 } = require("uuid");
const { MemorySource } = require("@orbit/memory");
const { WebSocket, WebSocketServer } = require("ws");
const { JSONAPISource } = require("@orbit/jsonapi");
const { Coordinator, RequestStrategy, SyncStrategy } = require("@orbit/coordinator");

const schema = require("./schema");

async function create(settings = {}) {
	let database = new MemorySource({ schema });
	let backing_store = null;
	let coordinator = null;

	let pending_pair_requests = {
		incoming: {},
		outgoing: []
	};

	if (settings.json_api) {
		backing_store = new JSONAPISource({
			schema,
			name: "remote",
			host: settings.json_api.host,
			namespace: settings.json_api.namespace
		});
		
		coordinator = new Coordinator();
		coordinator.addSource(database);
		coordinator.addSource(backing_store);
		coordinator.addStrategy(new RequestStrategy({
			source: "memory",
			on: "beforeQuery",
			target: "remote",
			action: "query",
			blocking: false
		}));
		coordinator.addStrategy(new RequestStrategy({
			source: "memory",
			on: "beforeUpdate",
			target: "remote",
			action: "update",
			blocking: false
		}));
		coordinator.addStrategy(new SyncStrategy({
			source: "remote",
			target: "memory",
			blocking: false
		}));
		await coordinator.activate();
	}

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
	
	function instantiate_server_information(id, name, address, port) {
		this_server = database.cache.query((q) => q.findRecord({ type: "peer", id }));
		if (!this_server) {
			this_server = {
				type: "peer",
				id,
				attributes: {
					name,
					address,
					port
				},
				relationships: {
					channels: { data: [] },
					users: { data: [] }
				}
			}

			database.update((t) => t.addRecord(this_server));
		}
		else {
			if (this_server.attributes.name !== name) {
				database.update((t) => t.replaceAttribute(this_server, "name", name));
			}
			if (this_server.attributes.address !== address) {
				database.update((t) => t.replaceAttribute(this_server, "address", address));
			}
			if (this_server.attributes.port !== port) {
				database.update((t) => t.replaceAttribute(this_server, "port", port));
			}
		}
	}
	
	function find_user_by_username(username) {
		let users = database.cache.query((q) =>
			q
				.findRecords("user")
				.filter({ attribute: "username", value: username })
				.page({offset: 0, limit: 1})
		);
	
		if (users && users.length > 0) {
			return users[0];
		} else {
			return null;
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
	
	async function create_user(username, admin = false) {
		if (find_user_by_username(username) != null) {
			return null;
		}
	
		const id = uuidv4();
	
		let user = {
			type: "user",
			id,
			attributes: { username, admin },
			relationships: {
				peer: { data: { type: "peer", id: this_server.id } }
			}
		};
	
		await database.update((t) => t.addRecord(user));
		emit("create_user", user);
		return id;
	}

	async function create_remote_user(username, id, peer_id) {
		/*if (find_user_by_username(username) != null) {
			return null;
		}*/
	
		let user = {
			type: "user",
			id,
			attributes: { username, admin: false },
			relationships: {
				peer: { data: { type: "peer", id: peer_id } }
			}
		};
	
		await database.update((t) => t.addRecord(user));
		emit("create_user", user);
		return id;
	}
	
	async function delete_user(id) {
		await database.update((t) => t.removeRecord({ type: "user", id }));
	}
	
	async function get_user(id) {
		return await database.query((q) => q.findRecord({ type: "user", id }));
	}
	
	async function login_user(id) {
		let user = await get_user(id);
	
		if (!user) {
			return false;
		}
	
		online_users[id] = true;
		emit("user_online", user);
		return true;
	}
	
	async function logout_user(id) {
		let user = await get_user(id);
	
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

	async function get_all_local_users() {
		let local_users = [];
	
		let users = await database.query((q) => q.findRecords("user"));
		// TODO: Probably could use Orbit filtering here
		for (let user of users) {
			if (user.relationships.peer.data.id == this_server.id) {
				local_users.push(user);
			}
		}
	
		return local_users;
	}
	
	async function get_all_online_local_users() {
		let online_local_users = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			if (user.relationships.peer.data.id == this_server.id) {
				online_local_users.push(user);
			}
		}
	
		return online_local_users;
	}
	
	async function get_all_online_remote_users() {
		let online_remote_users = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			if (user.relationships.peer.data.id != this_server.id) {
				online_remote_users.push(user);
			}
		}
	
		return online_remote_users;
	}
	
	async function get_online_users(channel_id) {
		if (!(await get_channel(channel_id))) {
			return null;
		}
	
		let online_users_in_channel = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			if (user.attributes.admin || !(await get_channel(channel_id)).attributes.admin_only) {
				online_users_in_channel.push(user);
			}
		}
	
		return online_users_in_channel;
	}
	
	async function get_online_local_users(channel_id) {
		if (!(await get_channel(channel_id))) {
			return null;
		}
	
		let online_local_users = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			if (user.relationships.peer.data.id == this_server.id && (user.attributes.admin || !(await get_channel(channel_id)).attributes.admin_only)) {
				online_local_users.push(user);
			}
		}
	
		return online_local_users;
	}
	
	async function get_online_remote_users(channel_id) {
		if (!get_channel(channel_id)) {
			return null;
		}
		
		let online_remote_users = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			if (user.relationships.peer.data.id != this_server.id && (user.attributes.admin || !(await get_channel(channel_id)).attributes.admin_only)) {
				online_remote_users.push(user);
			}
		}
	
		return online_remote_users;
	}
	
	async function get_all_channels() {
		return (await database.query((q) => q.findRecords("channel"))).sort((a, b) => {
			// Sort by creation time
			return a.attributes.timestamp - b.attributes.timestamp;
		});
	}
	
	async function get_all_local_channels() {
		return (await database.query((q) =>
			q
				.findRecords("channel")
				.filter({ relation: "peer", record: { type: "peer", id: this_server.id } })
		)).sort((a, b) => {
			return a.attributes.timestamp - b.attributes.timestamp;
		});
	}
	
	async function get_channel(id) {
		return await database.query((q) => q.findRecord({ type: "channel", id }));
	}
	
	async function find_channel_by_name(name) {
		let channels = await database.query((q) => q.findRecords("channel").filter({ attribute: "name", value: name }));
		if (channels && channels.length > 0) {
			return channels[0];
		}
		else {
			return null;
		}
	}
	
	async function create_channel(name, admin_only = false, is_private = false) {
		if (await find_channel_by_name(name)) {
			return null;
		}
	
		let channel = {
			type: "channel",
			id: uuidv4(),
			attributes: {
				name,
				admin_only,
				is_private,
				timestamp: Date.now()
			},
			relationships: {
				peer: { data: { type: "peer", id: this_server.id } }
			}
		}

		if (!is_private) {
			// Tell peers about new channel
			for (let peer_id in peer_connections) {
				let socket = peer_connections[peer_id];
				socket.send(JSON.stringify({
					type: "channel_create",
					id: channel.id,
					name,
					timestamp: channel.attributes.timestamp
				}));
			}
		}

		await database.update((t) => t.addRecord(channel));
		emit("channel_create", channel);
		return channel.id;
	}
	
	async function create_remote_channel(name, timestamp, channel_id, peer_id) {
		// Check if channel exists first
		if (await get_channel(channel_id)) {
			return null;
		}

		let channel = {
			type: "channel",
			id: channel_id,
			attributes: {
				name,
				admin_only: false,
				is_private: false,
				timestamp
			},
			relationships: {
				peer: { data: { type: "peer", id: peer_id } }
			}
		}
	
		await database.update((t) => t.addRecord(channel));
		emit("channel_create", channel);
		return channel.id;
	}
	
	async function delete_channel(id) {
		let channel = await get_channel(id);
	
		if (!channel || channel.relationships.peer.data.id != this_server.id) {
			return false;
		}
	
		// Also delete all associated messages
		/*await database.update((t) =>
			t.removeFromRelatedRecords({ type: "channel", id }, "messages", { type: "message", id: null })
		);*/
	
		if (!channel.attributes.is_private) {
			// Tell peers about channel deletion
			for (let peer_id in peer_connections) {
				let socket = peer_connections[peer_id];
				socket.send(JSON.stringify({
					type: "channel_delete",
					id: channel.id
				}));
			}
		}

		await database.update((t) => t.removeRecord({ type: "channel", id }));
	
		emit("channel_delete", id);
		return true;
	}

	async function delete_remote_channel(id) {
		let channel = await get_channel(id);
	
		if (!channel || channel.relationships.peer.data.id == this_server.id) {
			return false;
		}
	
		// Also delete all associated messages
		/*await database.update((t) =>
			t.removeFromRelatedRecords({ type: "channel", id }, "messages", { type: "message", id: null })
		);*/
	
		await database.update((t) => t.removeRecord({ type: "channel", id }));
	
		emit("channel_delete", id);
		return true;
	}
	
	async function send_message(user_id, channel_id, content) {
		let user = await get_user(user_id);
		let channel = await get_channel(channel_id);
	
		if (!channel || !online_users[user_id]) {
			return null;
		}

		if (channel.attributes.admin_only && !user.attributes.admin) {
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

		// If this message was sent from a local user we need to tell peers about it
		if (user.relationships.peer.data.id == this_server.id && !channel.attributes.is_private) {
			for (let peer_id in peer_connections) {
				// Only send to peers that we know can see the channel
				if (channel.relationships.peer.data.id == this_server.id || channel.relationships.peer.data.id == peer_id) {
					let socket = peer_connections[peer_id];
					socket.send(JSON.stringify({
						type: "send_message",
						user_id,
						channel_id,
						content
					}));
				}
			}
		}
	
		await database.update((t) => t.addRecord(message));
		emit("message", message);
		return message.id;
	}

	async function send_remote_message(user_id, channel_id, content, message_id, timestamp) {
		let channel = await get_channel(channel_id);

		if (!channel || !online_users[user_id]) {
			return null;
		}

		if (channel.attributes.admin_only || channel.attributes.is_private) {
			return null;
		}

		let message = {
			type: "message",
			id: message_id,
			attributes: {
				content,
				timestamp
			},
			relationships: {
				user: { data: { type: "user", id: user_id } },
				channel: { data: { type: "channel", id: channel_id } }
			}
		}

		await database.update((t) => t.addRecord(message));
		emit("message", message);
		return message.id;
	}
	
	async function delete_message(id) {
		await database.update((t) => t.removeRecord({ type: "message", id }));
		emit("message_delete", id);
	}
	
	async function get_messages(channel_id, timestamp, limit = 50) {
		let channel = await get_channel(channel_id);
	
		if (!channel) {
			return null;
		}
	
		return (await database.query((q) =>
			q
				.findRecords("message")
				.filter(
					{ relation: "channel", record: { type: "channel", id: channel_id }})
		))
			.filter((message) => message.attributes.timestamp < timestamp) // Annoyingly, I couldn't get this to work in the query
			.sort((a, b) => a.attributes.timestamp - b.attributes.timestamp)
			.slice(0, limit);
	}

	async function get_peer(id) {
		return await database.query((q) => q.findRecord({ type: "peer", id }));
	}
	
	async function peer_online(peer_id, socket) {
		let peer = await get_peer(peer_id);
		if (!peer) {
			return false;
		}
	
		peer_connections[peer_id] = socket;
		emit("peer_online", peer);
		return true;
	}

	async function add_peer(id, name, address, port) {
		let peer = {
			type: "peer",
			id,
			attributes: {
				name,
				address,
				port
			},
			relationships: {
				channels: { data: [] },
				users: { data: [] }
			}
		};
	
		await database.update((t) => t.addRecord(peer));
	}
	
	function set_up_handlers(peer_id, websocket) {
		websocket.on("message", async (message) => {
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
					await create_remote_user(data.username, data.id, peer_id);
					break;
				case "delete_user":
					// TODO: Security
					if (await delete_user(data.id)) {
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
				case "channel_create":
					let new_channel_id = await create_remote_channel(data.name, data.timestamp, data.id, peer_id);
					console.log(`Created channel ${new_channel_id} from peer ${peer_id}`);
					break;
				case "channel_delete":
					let channel = await get_channel(data.id);

					if (channel && channel.attributes.peer_id == peer_id) {
						let success = await delete_remote_channel(data.id)
						if (success) {
							console.log(`Deleted channel ${data.id} from peer ${peer_id}`);
						}
					}
					break;
				case "send_message":
					// TODO: ID parity
					console.log(`Received message from peer ${peer_id}: ${data.content}`);
					let result = await send_remote_message(data.user_id, data.channel_id, data.content, data.message_id, data.timestamp);
					if (result) {
						console.log("Success");
					} else {
						console.log("Failure");
					}
					break;
				case "delete_message":
					//let message = await get_message(data.id);
					// TODO: Security
					delete_message(data.id);
					break;
				case "get_messages":
					let messages = await get_messages(data.channel_id, data.timestamp, data.limit);
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
		ip = ip6addr.parse(ip).toString({ format: "v4" });

		if (ip == this_server.attributes.address && port == this_server.attributes.port) {
			return false;
		}

		if (pending_pair_requests.outgoing.find((pair_request) => {
			return pair_request.ip == ip && pair_request.port == port;
		})) {
			return false;
		}

		let socket = new WebSocket("ws://" + ip + ":" + port);
	
		socket.on("open", () => {
			socket.send(JSON.stringify({
				type: "pair_request",
				id: this_server.id,
				name: this_server.attributes.name,
				address: socket._socket.localAddress,
				port: this_server.attributes.port
			}));

			pending_pair_requests.outgoing.push({ socket: socket, ip: ip, port: port });
			socket.close();
		});

		return true;
	}

	async function inform_peer(id) {
		if (!peer_connections[id]) return false;
		let socket = peer_connections[id];
		let channels = await get_all_local_channels();
		let users = await get_all_local_users();

		for (let channel of channels) {
			if (!channel.attributes.admin_only) {
				socket.send(JSON.stringify({
					type: "channel_create",
					id: channel.id,
					name: channel.attributes.name,
					timestamp: channel.attributes.timestamp
				}));
			}
		}

		for (let user of users) {
			socket.send(JSON.stringify({
				type: "create_user",
				id: user.id,
				username: user.attributes.username
			}));
		}

		for (let user_id in online_users) {
			socket.send(JSON.stringify({
				type: "login",
				id: user_id
			}));
		}
	}

	async function respond_to_pair_request(id, accepted) {
		let pair_request = pending_pair_requests.incoming[id];
		
		if (!pair_request) {
			return false;
		}

		if (accepted) add_peer(id, pair_request.name, pair_request.address, pair_request.port);
		let socket = new WebSocket("ws://" + pair_request.address + ":" + pair_request.port);

		socket.on("open", () => {
			socket.once("message", async (message) => {
				let data = JSON.parse(message);
				if (data.type == "handshake_ack") {
					console.log(`Paired with peer ${pair_request.name} (${id})`);
					await peer_online(id, socket);
					set_up_handlers(id, socket);
					inform_peer(id);
				}
			});

			socket.send(JSON.stringify({
				type: accepted ? "pair_accept" : "pair_reject",
				id: this_server.id,
				name: this_server.attributes.name,
				address: socket._socket.localAddress,
				port: this_server.attributes.port
			}));
		});

		socket.on("error", (error) => {
			console.log(error);
		});

		return true;
	}
	
	async function has_peer(id) {
		return (await database.query((q) => q.findRecords("peer").filter({ attribute: "id", value: id }))).length > 0;
	}

	function connect_to_peer(peer) {
		if (peer.id == this_server.id) {
			return false;
		}
	
		if (peer_connections[peer.id]) {
			return false;
		}
	
		let socket = new WebSocket(`ws://${peer.attributes.address}:${peer.attributes.port}/`);
	
		socket.on("open", () => {
			socket.once("message", async (message) => {
				let data = JSON.parse(message);
				if (data.type == "handshake_ack") {
					console.log(`Connected to peer ${peer.attributes.name} (${peer.id})`);
					await peer_online(peer.id, socket);
					set_up_handlers(id, socket);
					inform_peer(id);
				}
			});

			socket.send(JSON.stringify({
				type: "handshake",
				id: this_server.id
			}));
		});
	
		return true;
	}
	
	function await_handshake_or_pair_request(socket) {
		return new Promise((resolve, reject) => {
			socket.on("message", (message) => {
				let data = JSON.parse(message);
				let address = ip6addr.parse(socket._socket.remoteAddress).toString({ format: "v4" });
				data.address = address;
	
				if (data.type == "handshake") {
					resolve(data);
				}
				else if (data.type == "pair_accept" && pending_pair_requests.outgoing.findIndex((request) => request.ip == address && request.port == data.port) != -1) {
					pending_pair_requests.outgoing = pending_pair_requests.outgoing.filter((request) => request.ip != address && request.port != data.port);
					add_peer(data.id, data.name, data.address, data.port).then(() => {
						emit("pair_accept", data);
						resolve(data);
					});
				}
				else if (data.type == "pair_reject" && pending_pair_requests.outgoing.findIndex((request) => request.ip == address && request.port == data.port) != -1) {
					pending_pair_requests.outgoing = pending_pair_requests.outgoing.filter((request) => request.ip != address && request.port != data.port);
					emit("pair_reject", data);
					reject("Pair request rejected");
				}
				else if (data.type == "pair_request") {
					has_peer(data.id).then((is_peer) => {
						if (is_peer) {
							socket.send(JSON.stringify({
								type: "pair_reject"
							}));
						}
						else {
							pending_pair_requests.incoming[data.id] = { name: data.name, address: address, port: data.port };
							emit("pair_request", data);
							reject(`Server ${address}:${data.port} is not yet paired, awaiting pair approval from admin to continue`);
						}
					});
				}
				else {
					reject(data);
				}
			});
		});
	}
	
	function start(config_path) {
		config = JSON.parse(fs.readFileSync(config_path, "utf8"));
		instantiate_server_information(config.server_id, config.server_name, "localhost", config.server_port);
		wss = new WebSocketServer({ port: config.server_port });
	
		wss.on("connection", (ws, req) => {
			console.log(`New connection from ${req.socket.remoteAddress}`);
			await_handshake_or_pair_request(ws).then((data) => {
				console.log(`Handshake from ${data.id}`);
				peer_online(data.id, ws);
				set_up_handlers(data.id, ws);

				ws.send(JSON.stringify({
					type: "handshake_ack"
				}), () => {
					console.log("Inform...");
					inform_peer(data.id);
				});
			}).catch((err) => {
				console.log("Peer handshake error:", err);
				ws.close();
			});
		});
	
		wss.on("error", (err) => {
			console.log(`Error in connection: ${err}`);
		});
	
		// Connect to all peers in Orbit database
		database.query((q) => q.findRecords("peer")).then((peers) => {
			peers.forEach((peer) => {
				if (peer.id != this_server.id) {
					connect_to_peer(peer);
				}
			});
		});
	}
	
	function stop() {
		if (wss != null) {
			wss.close();
			wss = null;
		}

		// Close all peer connections
		for (let peer_id in peer_connections) {
			if (peer_connections[peer_id].readyState == WebSocket.OPEN || peer_connections[peer_id].readyState == WebSocket.CONNECTING) {
				peer_connections[peer_id].close();
			}
		}
	}

	return {
		start, stop,
		on, off,
		send_message, get_messages, delete_message,
		create_channel, delete_channel,
		create_user, get_user, delete_user,
		login_user, logout_user,
		get_all_channels, get_channel,
		get_all_online_users, get_all_online_local_users, get_all_online_remote_users,
		get_online_users, get_online_local_users, get_online_remote_users,
		send_pair_request, respond_to_pair_request,
		get_peer,

		id: () => this_server.id,
		name: () => this_server.attributes.name,
		address: () => this_server.attributes.address,
		port: () => this_server.attributes.port
	}
}

module.exports = { create };