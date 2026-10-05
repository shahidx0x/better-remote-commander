package io.github.shahidx0x.brc.android.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

data class UiSelector(
    val text: String? = null,
    val textContains: String? = null,
    val viewId: String? = null,
    val contentDescription: String? = null,
    val className: String? = null,
    val clickable: Boolean? = null,
    val index: Int = 0,
)

class AccessibilityEngine {
    private fun service(): BrcAccessibilityService =
        BrcAccessibilityService.instance
            ?: error("BRC Accessibility Service is not connected.")

    fun uiTree(maxNodes: Int = 500): Map<String, Any?> {
        val service = service()
        val windows = service.windows
        var remaining = maxNodes.coerceIn(1, 2000)
        val serialized = mutableListOf<Map<String, Any?>>()

        for ((windowIndex, window) in windows.withIndex()) {
            if (remaining <= 0) break
            val root = window.root ?: continue
            val result = serializeNode(root, 0, remaining)
            remaining -= result.second
            serialized += mapOf(
                "windowIndex" to windowIndex,
                "type" to window.type,
                "layer" to window.layer,
                "active" to window.isActive,
                "focused" to window.isFocused,
                "accessibilityFocused" to window.isAccessibilityFocused,
                "root" to result.first,
            )
        }

        if (serialized.isEmpty()) {
            service.rootInActiveWindow?.let {
                serialized += mapOf(
                    "windowIndex" to 0,
                    "active" to true,
                    "root" to serializeNode(it, 0, remaining).first,
                )
            }
        }

        return mapOf(
            "windows" to serialized,
            "truncated" to (remaining <= 0),
            "maxNodes" to maxNodes,
        )
    }

    fun find(selector: UiSelector): Map<String, Any?> {
        val matches = findNodes(selector)
        val selected = matches.getOrNull(selector.index)
            ?: error("No accessibility element matched the selector.")
        return describeNode(selected)
    }

    fun click(selector: UiSelector): Map<String, Any?> {
        val node = selectedNode(selector)
        val target = clickableAncestor(node) ?: node
        val performed = target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        if (!performed) {
            val rect = Rect()
            node.getBoundsInScreen(rect)
            require(!rect.isEmpty) { "Element is not clickable and has no visible bounds." }
            require(tap(rect.centerX().toFloat(), rect.centerY().toFloat())) {
                "Accessibility click was rejected."
            }
        }
        return mapOf("clicked" to true, "element" to describeNode(node))
    }

    fun longPress(selector: UiSelector, durationMs: Long): Map<String, Any?> {
        val node = selectedNode(selector)
        if (node.isLongClickable && node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) {
            return mapOf("longPressed" to true, "element" to describeNode(node))
        }
        val rect = Rect()
        node.getBoundsInScreen(rect)
        require(!rect.isEmpty) { "Element has no visible bounds." }
        require(longPress(rect.centerX().toFloat(), rect.centerY().toFloat(), durationMs)) {
            "Accessibility long press was rejected."
        }
        return mapOf("longPressed" to true, "element" to describeNode(node))
    }

    fun inputText(selector: UiSelector, text: String): Map<String, Any?> {
        val node = selectedNode(selector)
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply {
            putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                text,
            )
        }
        require(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            "Target element does not accept accessibility text input."
        }
        return mapOf("input" to true, "textLength" to text.length)
    }

    fun focus(selector: UiSelector): Map<String, Any?> {
        val node = selectedNode(selector)
        require(node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)) {
            "Target element could not be focused."
        }
        return mapOf("focused" to true, "element" to describeNode(node))
    }

    fun scroll(selector: UiSelector?, forward: Boolean): Map<String, Any?> {
        val node = selector?.let(::selectedNode) ?: firstScrollableNode()
            ?: error("No scrollable accessibility element is available.")
        val action = if (forward) {
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        } else {
            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        }
        require(node.performAction(action)) { "Accessibility scroll was rejected." }
        return mapOf("scrolled" to true, "forward" to forward)
    }

    fun globalAction(action: Int): Boolean =
        service().performGlobalAction(action)

    fun tap(x: Float, y: Float): Boolean =
        dispatchGesture(path = Path().apply { moveTo(x, y) }, durationMs = 70)

    fun longPress(x: Float, y: Float, durationMs: Long): Boolean =
        dispatchGesture(
            path = Path().apply { moveTo(x, y) },
            durationMs = durationMs.coerceIn(300, 5000),
        )

    fun swipe(
        startX: Float,
        startY: Float,
        endX: Float,
        endY: Float,
        durationMs: Long,
    ): Boolean =
        dispatchGesture(
            path = Path().apply {
                moveTo(startX, startY)
                lineTo(endX, endY)
            },
            durationMs = durationMs.coerceIn(100, 5000),
        )

    private fun dispatchGesture(path: Path, durationMs: Long): Boolean {
        val service = service()
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
        val latch = CountDownLatch(1)
        var completed = false
        val accepted = service.dispatchGesture(
            gesture,
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    completed = true
                    latch.countDown()
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    completed = false
                    latch.countDown()
                }
            },
            null,
        )
        if (!accepted) return false
        latch.await((durationMs + 3000).coerceAtMost(8000), TimeUnit.MILLISECONDS)
        return completed
    }

    private fun selectedNode(selector: UiSelector): AccessibilityNodeInfo =
        findNodes(selector).getOrNull(selector.index)
            ?: error("No accessibility element matched the selector.")

    private fun findNodes(selector: UiSelector): List<AccessibilityNodeInfo> {
        val service = service()
        val roots = service.windows.mapNotNull { it.root }.ifEmpty {
            listOfNotNull(service.rootInActiveWindow)
        }
        val matches = mutableListOf<AccessibilityNodeInfo>()
        roots.forEach { root ->
            traverse(root) { node ->
                if (matchesSelector(node, selector)) matches += node
            }
        }
        return matches
    }

    private fun firstScrollableNode(): AccessibilityNodeInfo? {
        val service = service()
        val roots = service.windows.mapNotNull { it.root }.ifEmpty {
            listOfNotNull(service.rootInActiveWindow)
        }
        var match: AccessibilityNodeInfo? = null
        roots.forEach { root ->
            if (match == null) {
                traverse(root) { node ->
                    if (match == null && node.isScrollable) match = node
                }
            }
        }
        return match
    }

    private fun traverse(
        node: AccessibilityNodeInfo,
        visit: (AccessibilityNodeInfo) -> Unit,
    ) {
        visit(node)
        for (index in 0 until node.childCount) {
            node.getChild(index)?.let { traverse(it, visit) }
        }
    }

    private fun matchesSelector(
        node: AccessibilityNodeInfo,
        selector: UiSelector,
    ): Boolean {
        val nodeText = node.text?.toString().orEmpty()
        val description = node.contentDescription?.toString().orEmpty()
        if (selector.text != null && nodeText != selector.text) return false
        if (
            selector.textContains != null &&
            !nodeText.contains(selector.textContains, ignoreCase = true)
        ) return false
        if (selector.viewId != null && node.viewIdResourceName != selector.viewId) return false
        if (
            selector.contentDescription != null &&
            description != selector.contentDescription
        ) return false
        if (selector.className != null && node.className?.toString() != selector.className) {
            return false
        }
        if (selector.clickable != null && node.isClickable != selector.clickable) return false
        return selector.text != null ||
            selector.textContains != null ||
            selector.viewId != null ||
            selector.contentDescription != null ||
            selector.className != null ||
            selector.clickable != null
    }

    private fun clickableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var current: AccessibilityNodeInfo? = node
        repeat(8) {
            if (current?.isClickable == true) return current
            current = current?.parent
        }
        return null
    }

    private fun serializeNode(
        node: AccessibilityNodeInfo,
        depth: Int,
        remaining: Int,
    ): Pair<Map<String, Any?>, Int> {
        if (remaining <= 0) return emptyMap<String, Any?>() to 0
        var consumed = 1
        val children = mutableListOf<Map<String, Any?>>()
        if (depth < 40) {
            for (index in 0 until node.childCount) {
                if (consumed >= remaining) break
                val child = node.getChild(index) ?: continue
                val serialized = serializeNode(child, depth + 1, remaining - consumed)
                consumed += serialized.second
                if (serialized.first.isNotEmpty()) children += serialized.first
            }
        }
        val data = describeNode(node).toMutableMap()
        if (children.isNotEmpty()) data["children"] = children
        return data to consumed
    }

    private fun describeNode(node: AccessibilityNodeInfo): Map<String, Any?> {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        return linkedMapOf(
            "text" to node.text?.toString(),
            "contentDescription" to node.contentDescription?.toString(),
            "viewId" to node.viewIdResourceName,
            "className" to node.className?.toString(),
            "packageName" to node.packageName?.toString(),
            "bounds" to mapOf(
                "left" to bounds.left,
                "top" to bounds.top,
                "right" to bounds.right,
                "bottom" to bounds.bottom,
            ),
            "clickable" to node.isClickable,
            "longClickable" to node.isLongClickable,
            "scrollable" to node.isScrollable,
            "editable" to node.isEditable,
            "enabled" to node.isEnabled,
            "focused" to node.isFocused,
            "selected" to node.isSelected,
            "checked" to node.isChecked,
        )
    }
}
