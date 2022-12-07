const { RecordSchema } = require("@orbit/records");

module.exports = new RecordSchema({
	models: {
		peer: {
			attributes: {
				name: { type: "string" },
				address: { type: "string" },
				port: { type: "number" }
			},
			relationships: {
				channels: { kind: "hasMany", type: "channel", inverse: "peer" },
				users: { kind: "hasMany", type: "user", inverse: "peer" }
			}
		},
		user: {
			attributes: {
				username: { type: "string" },
				admin: { type: "boolean" },
				//local: { type: "boolean" }
			},
			relationships: {
				peer: { kind: "hasOne", type: "peer", inverse: "users" }
			}
		},
		channel: {
			attributes: {
				name: { type: "string" },
				admin_only: { type: "boolean" },
				is_private: { type: "boolean" },
				timestamp: { type: "number" }
			},
			relationships: {
				messages: { kind: "hasMany", type: "message", inverse: "channel" },
				peer: { kind: "hasOne", type: "peer", inverse: "channels" }
			}
		},
		message: {
			attributes: {
				content: { type: "string" },
				timestamp: { type: "number" }
			},
			relationships: {
				channel: { kind: "hasOne", type: "channel", inverse: "messages" },
				user: { kind: "hasOne", type: "user" }
			}
		}
	}
});