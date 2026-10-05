package io.github.shahidx0x.brc.android.accessibility

import android.accessibilityservice.AccessibilityService
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object AccessibilityToolProvider {
    fun register(registry: ToolRegistry) {
        val engine = AccessibilityEngine()

        registry
            .register(FunctionTool(
                ToolDefinition(
                    "android_ui_tree",
                    "Return the accessible Android window and UI node hierarchy.",
                    schema(
                        "maxNodes" to mapOf(
                            "type" to "integer",
                            "minimum" to 1,
                            "maximum" to 2000,
                        ),
                    ),
                ),
            ) { args ->
                ToolResults.json(
                    engine.uiTree(
                        ((args["maxNodes"] as? Number)?.toInt() ?: 500)
                            .coerceIn(1, 2000),
                    ),
                )
            })
            .register(FunctionTool(
                ToolDefinition(
                    "android_find_element",
                    "Find an Android UI element by semantic accessibility properties.",
                    selectorSchema(),
                ),
            ) { args -> ToolResults.json(engine.find(selector(args))) })
            .register(FunctionTool(
                ToolDefinition(
                    "android_click_element",
                    "Click a UI element selected by accessibility properties.",
                    selectorSchema(),
                ),
            ) { args -> ToolResults.json(engine.click(selector(args))) })
            .register(FunctionTool(
                ToolDefinition(
                    "android_click_coordinate",
                    "Tap screen coordinates using an accessibility gesture.",
                    schema(
                        "x" to numberSchema(),
                        "y" to numberSchema(),
                    ),
                ),
            ) { args ->
                val x = args.number("x").toFloat()
                val y = args.number("y").toFloat()
                require(engine.tap(x, y)) { "Accessibility tap was rejected." }
                ToolResults.json(mapOf("clicked" to true, "x" to x, "y" to y))
            })
            .register(FunctionTool(
                ToolDefinition(
                    "android_long_press",
                    "Long-press either a semantic UI element or explicit coordinates.",
                    combinedSelectorSchema(
                        "x" to numberSchema(),
                        "y" to numberSchema(),
                        "durationMs" to mapOf(
                            "type" to "integer",
                            "minimum" to 300,
                            "maximum" to 5000,
                        ),
                    ),
                ),
            ) { args ->
                val duration = ((args["durationMs"] as? Number)?.toLong() ?: 700L)
                    .coerceIn(300, 5000)
                if (args["x"] is Number && args["y"] is Number) {
                    val x = args.number("x").toFloat()
                    val y = args.number("y").toFloat()
                    require(engine.longPress(x, y, duration)) {
                        "Accessibility long press was rejected."
                    }
                    ToolResults.json(
                        mapOf(
                            "longPressed" to true,
                            "x" to x,
                            "y" to y,
                            "durationMs" to duration,
                        ),
                    )
                } else {
                    ToolResults.json(engine.longPress(selector(args), duration))
                }
            })
            .register(FunctionTool(
                ToolDefinition(
                    "android_swipe",
                    "Perform a swipe accessibility gesture between screen coordinates.",
                    schema(
                        "startX" to numberSchema(),
                        "startY" to numberSchema(),
                        "endX" to numberSchema(),
                        "endY" to numberSchema(),
                        "durationMs" to mapOf(
                            "type" to "integer",
                            "minimum" to 100,
                            "maximum" to 5000,
                        ),
                    ),
                ),
            ) { args ->
                val duration = ((args["durationMs"] as? Number)?.toLong() ?: 400L)
                    .coerceIn(100, 5000)
                require(
                    engine.swipe(
                        args.number("startX").toFloat(),
                        args.number("startY").toFloat(),
                        args.number("endX").toFloat(),
                        args.number("endY").toFloat(),
                        duration,
                    ),
                ) {
                    "Accessibility swipe was rejected."
                }
                ToolResults.json(mapOf("swiped" to true, "durationMs" to duration))
            })
            .register(FunctionTool(
                ToolDefinition(
                    "android_scroll",
                    "Scroll a selected or automatically detected scrollable accessibility element.",
                    combinedSelectorSchema(
                        "direction" to mapOf(
                            "type" to "string",
                            "enum" to listOf("forward", "backward"),
                        ),
                    ),
                ),
            ) { args ->
                val hasSelector = hasSelector(args)
                ToolResults.json(
                    engine.scroll(
                        if (hasSelector) selector(args) else null,
                        args["direction"] != "backward",
                    ),
                )
            })
            .register(FunctionTool(
                ToolDefinition(
                    "android_input_text",
                    "Replace text in an editable accessibility element.",
                    combinedSelectorSchema(
                        "value" to mapOf("type" to "string"),
                    ),
                ),
            ) { args ->
                val value = args["value"] as? String ?: error("value is required")
                ToolResults.json(engine.inputText(selector(args), value))
            })
            .register(FunctionTool(
                ToolDefinition(
                    "android_focus",
                    "Move accessibility focus to a selected UI element.",
                    selectorSchema(),
                ),
            ) { args -> ToolResults.json(engine.focus(selector(args))) })

        globalTool(registry, engine, "android_back", "Press Android Back.", AccessibilityService.GLOBAL_ACTION_BACK)
        globalTool(registry, engine, "android_home", "Press Android Home.", AccessibilityService.GLOBAL_ACTION_HOME)
        globalTool(registry, engine, "android_recents", "Open Android Recents.", AccessibilityService.GLOBAL_ACTION_RECENTS)
        globalTool(
            registry,
            engine,
            "android_notifications_panel",
            "Open the Android notification shade.",
            AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS,
        )
        globalTool(
            registry,
            engine,
            "android_quick_settings",
            "Open Android Quick Settings.",
            AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS,
        )
        globalTool(
            registry,
            engine,
            "android_power_dialog",
            "Open the Android system power dialog.",
            AccessibilityService.GLOBAL_ACTION_POWER_DIALOG,
        )
    }

    private fun globalTool(
        registry: ToolRegistry,
        engine: AccessibilityEngine,
        name: String,
        description: String,
        action: Int,
    ) {
        registry.register(
            FunctionTool(
                ToolDefinition(name, description, emptySchema()),
            ) {
                require(engine.globalAction(action)) {
                    "Android rejected accessibility global action $name."
                }
                ToolResults.json(mapOf("performed" to true, "action" to name))
            },
        )
    }

    private fun selector(args: Map<String, Any?>): UiSelector =
        UiSelector(
            text = args["text"] as? String,
            textContains = args["textContains"] as? String,
            viewId = args["viewId"] as? String,
            contentDescription = args["contentDescription"] as? String,
            className = args["className"] as? String,
            clickable = args["clickable"] as? Boolean,
            index = ((args["index"] as? Number)?.toInt() ?: 0).coerceAtLeast(0),
        ).also {
            require(hasSelector(args)) {
                "At least one semantic selector field is required."
            }
        }

    private fun hasSelector(args: Map<String, Any?>): Boolean =
        listOf(
            "text",
            "textContains",
            "viewId",
            "contentDescription",
            "className",
            "clickable",
        ).any { args.containsKey(it) }

    private fun Map<String, Any?>.number(key: String): Number =
        this[key] as? Number ?: error("$key is required")

    private fun selectorSchema(): Map<String, Any?> =
        schema(*selectorProperties())

    private fun combinedSelectorSchema(
        vararg additional: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        schema(*(selectorProperties() + additional))

    private fun selectorProperties(): Array<Pair<String, Map<String, Any?>>> =
        arrayOf(
            "text" to mapOf("type" to "string"),
            "textContains" to mapOf("type" to "string"),
            "viewId" to mapOf("type" to "string"),
            "contentDescription" to mapOf("type" to "string"),
            "className" to mapOf("type" to "string"),
            "clickable" to mapOf("type" to "boolean"),
            "index" to mapOf("type" to "integer", "minimum" to 0),
        )

    private fun schema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun numberSchema(): Map<String, Any?> =
        mapOf("type" to "number")
}
