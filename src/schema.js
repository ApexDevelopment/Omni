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
				channels: { type: "hasMany", model: "channel", inverse: "peers" },
				users: { type: "hasMany", model: "user", inverse: "peers" }
			}
		},
		user: {
			attributes: {
				username: { type: "string" },
				admin: { type: "boolean" },
				//local: { type: "boolean" }
			},
			relationships: {
				peer: { type: "hasOne", model: "peer", inverse: "users" }
			}
		},
		channel: {
			attributes: {
				name: { type: "string" },
				admin_only: { type: "boolean" },
				is_private: { type: "boolean" }
			},
			relationships: {
				messages: { type: "hasMany", model: "message", inverse: "channel" },
				peer: { type: "hasOne", model: "peer", inverse: "channels" }
			}
		},
		message: {
			attributes: {
				content: { type: "string" },
				timestamp: { type: "number" }
			},
			relationships: {
				channel: { type: "hasOne", model: "channel", inverse: "messages" },
				user: { type: "hasOne", model: "user", inverse: "messages" }
			}
		}
	}
});