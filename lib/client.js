window.__ModuleLoader__.load({
	id: "@local/dsh-pi-acp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const jsxRuntime = require("react/jsx-runtime");
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;

		/** English copy. */
		const en = {
			title: "pi (ACP)",
			description: "Drive the pi coding agent from DSH: default thinking level, model and per-turn budget.",
			thinking: "Thinking level",
			thinkingFollow: "Follow pi's own default",
			thinkingHint: "Leave on “follow” to use whatever pi resolves for the session.",
			thinkingHintModel: "Levels this model supports",
			thinkingUnsupported: "(not supported)",
			model: "Default model",
			followDefault: "Follow pi's own default model",
			effective: "In effect",
			modelHint: "Pick a model, then Save below. Turn the checkbox back on to drop the override.",
			modelPlaceholder: "(none)",
			modelListFailed: "Could not read the model list from the host.",
			modelUnknown: "(unknown)",
			timeoutMs: "Turn timeout (ms)",
			timeoutMsHint: "How long one pi turn may run before it is cancelled.",
			permission: "Tool permission",
			permissionHint: "allow answers pi's permission prompts with its first allow option; deny cancels them.",
			permissionAllow: "allow — answer automatically",
			permissionDeny: "deny — always cancel",
			maxConcurrent: "Concurrent turns",
			maxConcurrentHint: "How many pi turns may run at the same time.",
			overridden: "Overridden",
			reset: "Reset to default",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "The pi-acp settings entry is not served by this host, so the form cannot be edited right now.",
			invalidNumber: "Enter a number, or leave blank to use the default.",
			checking: "checking…",
			refresh: "Re-check",
			diagFailed: "Could not read the check result from the host.",
			diagReady: "ready",
			diagMissing: "not found",
			diagPiAcp: "pi-acp",
			diagPi: "pi",
		};
		/** Simplified Chinese copy. */
		const zh = {
			title: "pi（ACP）",
			description: "从 DSH 驱动 pi 编码智能体：默认思考强度、模型与单轮预算。",
			thinking: "思考强度",
			thinkingFollow: "跟随 pi 自己的默认",
			thinkingHint: "留在「跟随」就沿用 pi 为会话解析出的档位。",
			thinkingHintModel: "该模型支持的档位",
			thinkingUnsupported: "（不支持）",
			model: "默认模型",
			followDefault: "跟随 pi 自己的默认模型",
			effective: "当前生效",
			modelHint: "选中后在下方点「保存」生效；勾回跟随即清除这个覆盖。",
			modelPlaceholder: "（未选择）",
			modelListFailed: "读不到 pi 的模型列表。",
			modelUnknown: "（未知）",
			timeoutMs: "单轮超时（毫秒）",
			timeoutMsHint: "一轮 pi 任务最多运行多久，超时即中止。",
			permission: "工具权限",
			permissionHint: "allow：自动同意 pi 的权限询问；deny：一律取消。",
			permissionAllow: "allow —— 自动同意",
			permissionDeny: "deny —— 一律取消",
			maxConcurrent: "并发轮数",
			maxConcurrentHint: "最多同时运行几轮 pi 任务。",
			overridden: "已覆盖",
			reset: "恢复默认",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			readOnly: "本部署的设置为只读。",
			unavailable: "本宿主没有为 pi-acp 提供设置条目，表单暂时无法编辑。",
			invalidNumber: "请填数字；留空表示使用默认值。",
			checking: "检测中…",
			refresh: "重新检测",
			diagFailed: "读不到宿主的检测结果。",
			diagReady: "就绪",
			diagMissing: "未找到",
			diagPiAcp: "pi-acp",
			diagPi: "pi",
		};

		/**
		 * The labels the shared settings form renders.
		 * @param t - the page's locale reader.
		 * @returns the form's copy.
		 */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving"),
			};
		}

		/** Thin metadata line above the form. */
		const diagStyle = {
			display: "flex",
			flexWrap: "wrap",
			gap: "4px 16px",
			alignItems: "baseline",
			fontSize: 12,
			opacity: 0.75,
			marginBottom: 12,
		};
		/** Inline text button. */
		const linkStyle = {
			border: "none",
			background: "none",
			padding: 0,
			font: "inherit",
			cursor: "pointer",
			textDecoration: "underline",
			color: "inherit",
		};
		/** One stacked labelled row. */
		const rowStyle = { display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 };
		/** Row title. */
		const labelStyle = { fontSize: 13, fontWeight: 500 };
		/** Checkbox line. */
		const followRowStyle = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" };
		/** Muted explanation. */
		const hintStyle = { fontSize: 12, opacity: 0.65, lineHeight: "18px" };
		/** Native select styled to inherit the theme. */
		const selectStyle = {
			font: "inherit",
			fontSize: 13,
			padding: "6px 8px",
			borderRadius: 8,
			border: "1px solid currentColor",
			background: "transparent",
			color: "inherit",
			maxWidth: 460,
		};

		/**
		 * Installation line: asks the host whether `pi-acp` and `pi` resolve.
		 * @param props - the page's locale reader.
		 * @returns the metadata line.
		 */
		function DiagnoseRow(props) {
			const { t } = props;
			const [state, setState] = React.useState({ phase: "checking", data: null });
			const load = React.useCallback(() => {
				setState({ phase: "checking", data: null });
				fetch("/pi-acp/diagnose", { headers: { accept: "application/json" } })
					.then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
					.then((data) => setState({ phase: "done", data }))
					.catch(() => setState({ phase: "failed", data: null }));
			}, []);
			React.useEffect(() => {
				load();
			}, [load]);
			const data = state.data;
			const piAcp = data && data.piAcp ? data.piAcp : null;
			const pi = data && data.pi ? data.pi : null;
			let status;
			if (state.phase === "checking") status = t("checking");
			else if (state.phase === "failed") status = t("diagFailed");
			else if (data && data.ok === true) status = t("diagReady");
			else status = (data && data.error) || t("diagMissing");
			const piAcpText = piAcp
				? `${piAcp.version || "?"}${piAcp.exists === false ? ` (${t("diagMissing")})` : ""}`
				: "—";
			const piText = pi && pi.version ? pi.version : "—";
			return jsxs("div", {
				style: diagStyle,
				children: [
					jsx("span", { children: `${t("diagPiAcp")}: ${piAcpText}` }),
					jsx("span", { children: `${t("diagPi")}: ${piText}` }),
					jsx("span", { children: status }),
					jsx("button", { type: "button", style: linkStyle, onClick: load, children: t("refresh") }),
				],
			});
		}

		/**
		 * Load pi's model catalogue once per mount.
		 * @returns {{phase: string, models: object[], thinkingLevels: string[], defaults: object | null}} the catalogue.
		 */
		function useCatalog() {
			const [catalog, setCatalog] = React.useState({
				phase: "loading",
				models: [],
				thinkingLevels: [],
				defaults: null,
			});
			React.useEffect(() => {
				let alive = true;
				fetch("/pi-acp/models", { headers: { accept: "application/json" } })
					.then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
					.then((data) => {
						if (!alive) return;
						setCatalog({
							phase: "ready",
							models: Array.isArray(data.models) ? data.models : [],
							thinkingLevels: Array.isArray(data.thinkingLevels) ? data.thinkingLevels : [],
							defaults: data.defaults ?? null,
						});
					})
					.catch(() => {
						if (alive) setCatalog({ phase: "failed", models: [], thinkingLevels: [], defaults: null });
					});
				return () => {
					alive = false;
				};
			}, []);
			return catalog;
		}

		/**
		 * Model row: follow pi's own default, or pick one from pi's catalogue.
		 * @param props - locale copy, form value and actions, and the catalogue.
		 * @returns the row.
		 */
		function ModelSection(props) {
			const { t, disabled, value, edit, reset, catalog } = props;
			const [custom, setCustom] = React.useState(typeof value === "string" && value !== "");
			const following = !custom;
			const effective =
				catalog.defaults && catalog.defaults.effective ? catalog.defaults.effective : t("modelUnknown");
			const groups = React.useMemo(() => {
				const map = new Map();
				for (const model of catalog.models) {
					if (!map.has(model.provider)) map.set(model.provider, []);
					map.get(model.provider).push(model);
				}
				return [...map.entries()];
			}, [catalog.models]);
			const toggleFollow = (checked) => {
				if (checked) {
					setCustom(false);
					reset("model");
					return;
				}
				setCustom(true);
				if (typeof value !== "string" || value === "") {
					const first = catalog.models[0];
					if (first !== undefined) edit("model", first.id);
				}
			};
			let control;
			if (following) {
				control = jsx("span", { style: hintStyle, children: `${t("effective")}: ${effective}` });
			} else if (catalog.phase === "failed") {
				control = jsx("span", { style: hintStyle, children: t("modelListFailed") });
			} else {
				control = jsx("select", {
					value: typeof value === "string" ? value : "",
					disabled: disabled || catalog.phase !== "ready",
					style: selectStyle,
					onChange: (event) => edit("model", event.target.value),
					children: [
						jsx("option", { value: "", children: t("modelPlaceholder") }, "placeholder"),
						...groups.map(([provider, models]) =>
							jsx(
								"optgroup",
								{
									label: provider,
									children: models.map((model) =>
										jsx("option", { value: model.id, children: `${model.id} — ${model.name}` }, `${provider}:${model.id}`),
									),
								},
								provider,
							),
						),
					],
				});
			}
			return jsxs("div", {
				style: rowStyle,
				children: [
					jsx("span", { style: labelStyle, children: t("model") }),
					jsxs("label", {
						style: followRowStyle,
						children: [
							jsx("input", {
								type: "checkbox",
								checked: following,
								disabled,
								onChange: (event) => toggleFollow(event.target.checked),
							}),
							jsx("span", { children: t("followDefault") }),
						],
					}),
					control,
					following ? null : jsx("span", { style: hintStyle, children: t("modelHint") }),
				].filter((child) => child !== null && child !== undefined),
			});
		}

		/**
		 * Thinking row: a select over pi's levels, with the ones the current model
		 * cannot use disabled, plus a "follow pi" entry.
		 * @param props - locale copy, form value and actions, the catalogue, and the current model's levels.
		 * @returns the row.
		 */
		function ThinkingSection(props) {
			const { t, disabled, value, edit, reset, catalog, currentModelId, supported } = props;
			const levels =
				Array.isArray(catalog.thinkingLevels) && catalog.thinkingLevels.length > 0
					? catalog.thinkingLevels
					: ["off", "minimal", "low", "medium", "high", "max"];
			const options = [
				jsx("option", { value: "", children: t("thinkingFollow") }, "follow"),
				...levels.map((level) => {
					const usable = supported === null || supported === undefined || supported.includes(level);
					return jsx(
						"option",
						{ value: level, disabled: !usable, children: usable ? level : `${level} ${t("thinkingUnsupported")}` },
						level,
					);
				}),
			];
			const hint =
				supported === null || supported === undefined
					? t("thinkingHint")
					: `${t("thinkingHintModel")}: ${currentModelId || t("modelUnknown")} → ${supported.join(" / ")}`;
			return jsxs("div", {
				style: rowStyle,
				children: [
					jsx("span", { style: labelStyle, children: t("thinking") }),
					jsx("select", {
						value: typeof value === "string" ? value : "",
						disabled,
						style: selectStyle,
						onChange: (event) => {
							const next = event.target.value;
							if (next === "") reset("thinking");
							else edit("thinking", next);
						},
						children: options,
					}),
					jsx("span", { style: hintStyle, children: hint }),
				],
			});
		}

		/**
		 * Permission row: `allow` or `deny`, as a select instead of free text.
		 * @param props - locale copy, form value and actions.
		 * @returns the row.
		 */
		function PermissionSection(props) {
			const { t, disabled, value, edit, reset } = props;
			const current = value === "deny" ? "deny" : "allow";
			return jsxs("div", {
				style: rowStyle,
				children: [
					jsx("span", { style: labelStyle, children: t("permission") }),
					jsx("select", {
						value: current,
						disabled,
						style: selectStyle,
						onChange: (event) => {
							if (event.target.value === "allow") reset("permission");
							else edit("permission", event.target.value);
						},
						children: [
							jsx("option", { value: "allow", children: t("permissionAllow") }, "allow"),
							jsx("option", { value: "deny", children: t("permissionDeny") }, "deny"),
						],
					}),
					jsx("span", { style: hintStyle, children: t("permissionHint") }),
				],
			});
		}

		/**
		 * The section body: installation line, model / thinking / permission rows,
		 * then the remaining numeric fields in the shared settings form.
		 * @param props - locale copy, the form snapshot and its actions.
		 * @returns the section body.
		 */
		function PiForm(props) {
			const { t } = props;
			const state = props.usePiConfig((snapshot) => snapshot);
			const catalog = useCatalog();
			const disabled = !state.writable;
			const read = (name) =>
				state[name] && typeof state[name] === "object" ? (state[name].value ?? state[name].text ?? "") : "";
			const modelValue = read("model");
			const currentModelId = modelValue !== "" ? modelValue : (catalog.defaults && catalog.defaults.modelId) || "";
			const supported = React.useMemo(() => {
				if (catalog.phase !== "ready") return null;
				const found = catalog.models.find((model) => model.id === currentModelId);
				return found && Array.isArray(found.thinking) ? found.thinking : null;
			}, [catalog, currentModelId]);
			const field = (name, id, labelKey, hintKey, numeric) =>
				jsx(
					primitives.SettingsValueField,
					{
						id,
						label: t(labelKey),
						hint: t(hintKey),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidNumber"),
						numeric: numeric === true,
						disabled,
						...state[name],
						onEdit: (text) => {
							props.edit(name, text);
						},
						onReset: () => {
							props.resetField(name);
						},
					},
					id,
				);
			return jsxs("div", {
				children: [
					jsx(DiagnoseRow, { t }),
					jsx(ModelSection, {
						t,
						disabled,
						value: modelValue,
						edit: props.edit,
						reset: props.resetField,
						catalog,
					}),
					jsx(ThinkingSection, {
						t,
						disabled,
						value: read("thinking"),
						edit: props.edit,
						reset: props.resetField,
						catalog,
						currentModelId,
						supported,
					}),
					jsx(PermissionSection, {
						t,
						disabled,
						value: read("permission"),
						edit: props.edit,
						reset: props.resetField,
					}),
					jsx(primitives.SettingsForm, {
						labels: formLabels(t),
						state,
						onSave: props.save,
						onDiscard: props.discard,
						children: [
							field("timeoutMs", "plugin-config-pi-timeout", "timeoutMs", "timeoutMsHint", true),
							field("maxConcurrent", "plugin-config-pi-concurrency", "maxConcurrent", "maxConcurrentHint", true),
						],
					}),
				],
			});
		}

		/**
		 * The pi settings section.
		 * @param props - locale copy, the form snapshot and its actions.
		 * @returns the section body.
		 */
		function PiCard(props) {
			const { t } = props;
			if (props.view === "summary") return t("description");
			if (typeof props.usePiConfig !== "function") {
				return jsxs("div", { children: [jsx(DiagnoseRow, { t }), jsx("p", { children: t("unavailable") })] });
			}
			return jsx(PiForm, props);
		}

		/**
		 * Navigation glyph: a pi (π) mark, drawn at the size the shell asks for.
		 * @param props - pixel size and active state from the settings shell.
		 * @returns the glyph.
		 */
		function PiIcon(props) {
			const size = typeof props.size === "number" ? props.size : 16;
			return jsx(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					children: [
						jsx("path", { d: "M2.5 5.5h11" }, "bar"),
						jsx("path", { d: "M5.5 5.5v8" }, "left"),
						jsx("path", { d: "M10.5 5.5v8" }, "right"),
					],
				},
				"pi-icon",
			);
		}

		/** Bridges the profile entry's form onto the section's staged form. */
		class PiCardController {
			/**
			 * @param scope - the shared configuration form of the pi-acp entry.
			 */
			constructor(scope) {
				this.form = new primitives.SettingsFormModel(scope, [
					primitives.settingsTextField("thinking"),
					primitives.settingsTextField("model"),
					primitives.settingsNumberField("timeoutMs"),
					primitives.settingsTextField("permission"),
					primitives.settingsNumberField("maxConcurrent"),
				]);
				this.store = this.form.bind(() => this.projection());
			}
			/** @returns the section snapshot. */
			projection() {
				return {
					...this.form.shell(),
					thinking: this.form.field("thinking"),
					model: this.form.field("model"),
					timeoutMs: this.form.field("timeoutMs"),
					permission: this.form.field("permission"),
					maxConcurrent: this.form.field("maxConcurrent"),
				};
			}
			/** @returns the face the slot registration injects. */
			inject() {
				return {
					hooks: { piConfig: this.store },
					...this.form.actions(),
				};
			}
			/** Release the form subscription. */
			dispose() {
				this.form.dispose();
			}
		}

		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.piAcp";
		/**
		 * Settings namespaces this entry may appear under. The Host serves the
		 * row's own id (`pi-acp`); the loader's include-group id is only a
		 * fallback for compositions that nest it differently.
		 */
		const CONFIG_NAMESPACES = ["pi-acp", "include:pi-acp"];
		/** Services required by the section registration. */
		const inject = ["slots", "locale", "configForms"];

		/**
		 * Contribute a top-level section to Settings, next to Models and Plugins.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(
				() =>
					ctx.locale.register(NS, {
						zh,
						en,
					}),
				"pi-acp: dictionaries",
			);
			let card = null;
			for (const namespace of CONFIG_NAMESPACES) {
				try {
					card = new PiCardController(ctx.configForms.get(namespace));
					break;
				} catch (error) {
					ctx.logger?.error?.(error);
				}
			}
			if (card !== null) {
				ctx.effect(() => () => card.dispose(), "pi-acp: form subscription");
			}
			ctx.effect(
				() =>
					ctx.slots.inject("settings.section", () =>
						ctx.slots.register(
							{
								name: "settings.section",
								id: "pi-acp",
								order: 18,
								label: () => t("title"),
								locale: NS,
								inject: () => (card === null ? {} : card.inject()),
							},
							PiCard,
						),
					),
				"pi-acp: settings section",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("settings.section.icon", () =>
						ctx.slots.register(
							{
								name: "settings.section.icon",
								id: "pi-acp",
								locale: NS,
							},
							PiIcon,
						),
					),
				"pi-acp: section icon",
			);
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
