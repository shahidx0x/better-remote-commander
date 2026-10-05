package io.github.shahidx0x.brc.android.automation

import io.github.shahidx0x.brc.android.accessibility.AccessibilityEngine
import io.github.shahidx0x.brc.android.accessibility.UiSelector
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean

enum class AutomationStatus {
    QUEUED,
    RUNNING,
    COMPLETED,
    FAILED,
    CANCELLED,
}

data class AutomationEvent(
    val timestampMs: Long,
    val type: String,
    val stepIndex: Int? = null,
    val message: String? = null,
    val data: Map<String, Any?>? = null,
) {
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "timestampMs" to timestampMs,
        "type" to type,
        "stepIndex" to stepIndex,
        "message" to message,
        "data" to data,
    )
}

class AutomationJob(
    val id: String,
    val name: String?,
    val createdAtMs: Long,
    val steps: List<Map<String, Any?>>,
) {
    @Volatile var status: AutomationStatus = AutomationStatus.QUEUED
    @Volatile var currentStep: Int = -1
    @Volatile var startedAtMs: Long? = null
    @Volatile var finishedAtMs: Long? = null
    @Volatile var error: String? = null
    val cancelled = AtomicBoolean(false)
    private val events = ArrayDeque<AutomationEvent>()
    @Volatile var future: Future<*>? = null

    @Synchronized
    fun addEvent(event: AutomationEvent) {
        events.addLast(event)
        while (events.size > MAX_EVENTS) events.removeFirst()
    }

    @Synchronized
    fun eventSnapshot(): List<AutomationEvent> = events.toList()

    fun snapshot(includeSteps: Boolean = false): Map<String, Any?> =
        linkedMapOf(
            "taskId" to id,
            "name" to name,
            "status" to status.name.lowercase(),
            "createdAtMs" to createdAtMs,
            "startedAtMs" to startedAtMs,
            "finishedAtMs" to finishedAtMs,
            "currentStep" to currentStep,
            "stepCount" to steps.size,
            "error" to error,
            "steps" to if (includeSteps) steps else null,
        )

    private companion object {
        const val MAX_EVENTS = 200
    }
}

class AutomationManager(
    private val registry: ToolRegistry,
) {
    private val executor = Executors.newCachedThreadPool()
    private val jobs = ConcurrentHashMap<String, AutomationJob>()
    private val accessibility = AccessibilityEngine()

    fun start(
        name: String?,
        steps: List<Map<String, Any?>>,
    ): AutomationJob {
        require(steps.isNotEmpty()) { "Automation requires at least one step." }
        require(steps.size <= MAX_STEPS) {
            "Automation is limited to $MAX_STEPS steps."
        }
        cleanupOldJobs()

        val id = UUID.randomUUID().toString()
        val job = AutomationJob(
            id = id,
            name = name?.takeIf { it.isNotBlank() },
            createdAtMs = System.currentTimeMillis(),
            steps = steps,
        )
        jobs[id] = job
        job.addEvent(
            AutomationEvent(
                timestampMs = System.currentTimeMillis(),
                type = "queued",
                message = "Automation queued.",
            ),
        )
        job.future = executor.submit { run(job) }
        return job
    }

    fun get(taskId: String): AutomationJob =
        jobs[taskId] ?: error("Automation task not found: $taskId")

    fun cancel(taskId: String): AutomationJob {
        val job = get(taskId)
        if (
            job.status == AutomationStatus.COMPLETED ||
            job.status == AutomationStatus.FAILED ||
            job.status == AutomationStatus.CANCELLED
        ) {
            return job
        }
        job.cancelled.set(true)
        job.future?.cancel(true)
        job.status = AutomationStatus.CANCELLED
        job.finishedAtMs = System.currentTimeMillis()
        job.addEvent(
            AutomationEvent(
                timestampMs = System.currentTimeMillis(),
                type = "cancelled",
                stepIndex = job.currentStep.takeIf { it >= 0 },
                message = "Automation cancelled.",
            ),
        )
        return job
    }

    fun events(taskId: String, afterIndex: Int = 0): Map<String, Any?> {
        val job = get(taskId)
        val all = job.eventSnapshot()
        val start = afterIndex.coerceIn(0, all.size)
        return mapOf(
            "taskId" to taskId,
            "nextIndex" to all.size,
            "events" to all.drop(start).map(AutomationEvent::toMap),
        )
    }

    private fun run(job: AutomationJob) {
        job.status = AutomationStatus.RUNNING
        job.startedAtMs = System.currentTimeMillis()
        job.addEvent(
            AutomationEvent(
                timestampMs = System.currentTimeMillis(),
                type = "started",
                message = "Automation started.",
            ),
        )

        try {
            job.steps.forEachIndexed { index, step ->
                checkCancelled(job)
                job.currentStep = index
                job.addEvent(
                    AutomationEvent(
                        timestampMs = System.currentTimeMillis(),
                        type = "step_started",
                        stepIndex = index,
                        data = mapOf("type" to stepType(step)),
                    ),
                )

                val result = executeStep(job, index, step)

                job.addEvent(
                    AutomationEvent(
                        timestampMs = System.currentTimeMillis(),
                        type = "step_completed",
                        stepIndex = index,
                        data = result,
                    ),
                )
            }

            checkCancelled(job)
            job.status = AutomationStatus.COMPLETED
            job.finishedAtMs = System.currentTimeMillis()
            job.addEvent(
                AutomationEvent(
                    timestampMs = System.currentTimeMillis(),
                    type = "completed",
                    message = "Automation completed.",
                ),
            )
        } catch (interrupted: InterruptedException) {
            Thread.currentThread().interrupt()
            if (job.status != AutomationStatus.CANCELLED) {
                job.status = AutomationStatus.CANCELLED
                job.finishedAtMs = System.currentTimeMillis()
                job.addEvent(
                    AutomationEvent(
                        timestampMs = System.currentTimeMillis(),
                        type = "cancelled",
                        stepIndex = job.currentStep.takeIf { it >= 0 },
                        message = "Automation interrupted.",
                    ),
                )
            }
        } catch (error: Throwable) {
            if (job.cancelled.get()) {
                job.status = AutomationStatus.CANCELLED
            } else {
                job.status = AutomationStatus.FAILED
                job.error = error.message ?: error::class.java.simpleName
                job.addEvent(
                    AutomationEvent(
                        timestampMs = System.currentTimeMillis(),
                        type = "failed",
                        stepIndex = job.currentStep.takeIf { it >= 0 },
                        message = job.error,
                    ),
                )
            }
            job.finishedAtMs = System.currentTimeMillis()
        }
    }

    private fun executeStep(
        job: AutomationJob,
        index: Int,
        step: Map<String, Any?>,
    ): Map<String, Any?> {
        val type = stepType(step)
        return when (type) {
            "tool" -> executeToolStep(step)
            "delay" -> {
                val delayMs = (step["delayMs"] as? Number)?.toLong()
                    ?: error("delay step requires delayMs")
                require(delayMs in 0L..MAX_DELAY_MS) {
                    "delayMs must be between 0 and $MAX_DELAY_MS."
                }
                sleepInterruptibly(job, delayMs)
                mapOf("delayMs" to delayMs)
            }
            "waitForText" -> waitForText(job, step)
            "waitForApp" -> waitForApp(job, step)
            else -> error("Unsupported automation step type at index $index: $type")
        }
    }

    private fun executeToolStep(step: Map<String, Any?>): Map<String, Any?> {
        val toolName = (step["tool"] as? String)?.takeIf { it.isNotBlank() }
            ?: error("tool step requires tool")
        require(toolName !in CONTROL_TOOL_NAMES) {
            "Automation control tools cannot be invoked recursively."
        }
        val tool = registry.get(toolName)
            ?: error("Unknown Android tool: $toolName")
        @Suppress("UNCHECKED_CAST")
        val args = step["args"] as? Map<String, Any?> ?: emptyMap()
        val result = tool.execute(args)
        val text = result.content.firstOrNull { it.type == "text" }?.text
        return linkedMapOf(
            "tool" to toolName,
            "isError" to result.isError,
            "text" to text?.take(MAX_EVENT_TEXT),
            "contentTypes" to result.content.map { it.type },
        )
    }

    private fun waitForText(
        job: AutomationJob,
        step: Map<String, Any?>,
    ): Map<String, Any?> {
        val text = (step["text"] as? String)?.takeIf { it.isNotBlank() }
            ?: error("waitForText step requires text")
        val exact = step["exact"] as? Boolean ?: false
        val timeoutMs = timeout(step)
        val pollMs = pollInterval(step)
        val deadline = System.currentTimeMillis() + timeoutMs
        var lastError: String? = null
        while (System.currentTimeMillis() <= deadline) {
            checkCancelled(job)
            val found = runCatching {
                accessibility.find(
                    if (exact) UiSelector(text = text)
                    else UiSelector(textContains = text),
                )
            }
            if (found.isSuccess) {
                return mapOf(
                    "matched" to true,
                    "text" to text,
                    "element" to found.getOrThrow(),
                )
            }
            lastError = found.exceptionOrNull()?.message
            sleepInterruptibly(job, pollMs)
        }
        error("Timed out waiting for text '$text'. Last result: ${lastError ?: "not found"}")
    }

    private fun waitForApp(
        job: AutomationJob,
        step: Map<String, Any?>,
    ): Map<String, Any?> {
        val packageName = (step["package"] as? String)?.takeIf { it.isNotBlank() }
            ?: error("waitForApp step requires package")
        val timeoutMs = timeout(step)
        val pollMs = pollInterval(step)
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() <= deadline) {
            checkCancelled(job)
            val tree = runCatching { accessibility.uiTree(200) }.getOrNull()
            if (tree != null && containsPackage(tree, packageName)) {
                return mapOf("matched" to true, "package" to packageName)
            }
            sleepInterruptibly(job, pollMs)
        }
        error("Timed out waiting for app package '$packageName'.")
    }

    private fun containsPackage(value: Any?, packageName: String): Boolean =
        when (value) {
            is Map<*, *> -> value.entries.any { (key, child) ->
                (key == "packageName" && child == packageName) ||
                    containsPackage(child, packageName)
            }
            is Iterable<*> -> value.any { containsPackage(it, packageName) }
            else -> false
        }

    private fun timeout(step: Map<String, Any?>): Long =
        ((step["timeoutMs"] as? Number)?.toLong() ?: 15_000L)
            .coerceIn(1_000L, MAX_WAIT_MS)

    private fun pollInterval(step: Map<String, Any?>): Long =
        ((step["pollMs"] as? Number)?.toLong() ?: 400L)
            .coerceIn(100L, 5_000L)

    private fun sleepInterruptibly(job: AutomationJob, durationMs: Long) {
        var remaining = durationMs
        while (remaining > 0) {
            checkCancelled(job)
            val chunk = minOf(remaining, 500L)
            Thread.sleep(chunk)
            remaining -= chunk
        }
    }

    private fun checkCancelled(job: AutomationJob) {
        if (job.cancelled.get() || Thread.currentThread().isInterrupted) {
            throw InterruptedException("Automation cancelled.")
        }
    }

    private fun stepType(step: Map<String, Any?>): String {
        (step["type"] as? String)?.takeIf { it.isNotBlank() }?.let { return it }
        return when {
            step.containsKey("tool") -> "tool"
            step.containsKey("delayMs") -> "delay"
            step.containsKey("text") -> "waitForText"
            step.containsKey("package") -> "waitForApp"
            else -> error("Automation step has no recognizable type.")
        }
    }

    private fun cleanupOldJobs() {
        if (jobs.size < MAX_JOBS) return
        val removable = jobs.values
            .filter {
                it.status == AutomationStatus.COMPLETED ||
                    it.status == AutomationStatus.FAILED ||
                    it.status == AutomationStatus.CANCELLED
            }
            .sortedBy { it.finishedAtMs ?: Long.MAX_VALUE }
            .take((jobs.size - MAX_JOBS + 1).coerceAtLeast(1))
        removable.forEach { jobs.remove(it.id) }
        require(jobs.size < MAX_JOBS) {
            "Too many active automation jobs."
        }
    }

    companion object {
        private const val MAX_STEPS = 100
        private const val MAX_JOBS = 50
        private const val MAX_DELAY_MS = 300_000L
        private const val MAX_WAIT_MS = 300_000L
        private const val MAX_EVENT_TEXT = 8_000
        private val CONTROL_TOOL_NAMES = setOf(
            "android_start_task",
            "android_task_status",
            "android_cancel_task",
            "android_task_events",
        )
    }
}
