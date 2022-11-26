const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { MemorySource } = require("@orbit/memory");
//const { JSONAPISource } = require("@orbit/jsonapi");

const schema = require("./schema");
const memory = new MemorySource({ schema });

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

/*return {
	type: "channel",
	id: this.id,
	attributes: {
		name: this.name,
		admin_only: this.admin_only,
		is_private: this.is_private
	},
	relationships: {
		peer: { data: { type: "peer", id: this.origin } }
	}
};*/

/*return {
	type: "user",
	id: this.id,
	attributes: {
		username: this.username,
		admin: this.admin
	},
	relationships: {
		peer: { data: { type: "peer", id: this.origin } }
	}
};*/

/*return {
	type: "message",
	id: this.id,
	attributes: {
		content: this.content,
		timestamp: this.timestamp
	},
	relationships: {
		channel: { data: { type: "channel", id: this.channel_id } },
		user: { data: { type: "user", id: this.user_id } }
	}
};*/

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

function create_user(username, admin = false) {
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

function create_channel(name) {
	let channel = {
		type: "channel",
		id: uuidv4(),
		attributes: {
			name: name,
			admin_only: false,
			is_private: false
		},
		relationships: {
			peer: { data: { type: "peer", id: this_server.id } }
		}
	}

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
			.filter((record) => record.attributes.timestamp <= timestamp)
			.sortBy("timestamp")
			.page({offset: 0, limit})
	);
}

function start(config_path) {
	config = JSON.parse(fs.readFileSync(config_path, "utf8"));
	load_server_or_make_default(config.server_id, config.server_name);
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