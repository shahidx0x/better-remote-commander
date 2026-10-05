package io.github.shahidx0x.brc.android.telephony

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.CallLog
import android.provider.Telephony
import android.telecom.TelecomManager
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object TelephonyToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(dialTool(app))
            .register(makeCallTool(app))
            .register(callStateTool(app))
            .register(callLogTool(app))
            .register(answerCallTool(app))
            .register(endCallTool(app))
            .register(readSmsTool(app))
            .register(searchSmsTool(app))
            .register(sendSmsTool(app))
    }

    private fun dialTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_dial",
            description = "Open the Android dialer with a phone number filled in.",
            inputSchema = numberSchema(),
        ),
    ) { args ->
        val number = requireString(args, "number")
        context.startActivity(
            Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number)))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        ToolResults.json(mapOf("opened" to true, "number" to number))
    }

    private fun makeCallTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_make_call",
            description = "Place a phone call after the owner grants CALL_PHONE permission.",
            inputSchema = numberSchema(),
        ),
    ) { args ->
        requirePermission(context, Manifest.permission.CALL_PHONE)
        val number = requireString(args, "number")
        context.startActivity(
            Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number)))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        ToolResults.json(mapOf("requested" to true, "number" to number))
    }

    private fun callStateTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_call_state",
            description = "Return telephony and current call state information.",
            inputSchema = emptySchema(),
        ),
    ) {
        requirePermission(context, Manifest.permission.READ_PHONE_STATE)
        val manager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        @Suppress("DEPRECATION")
        val state = manager.callState
        ToolResults.json(
            linkedMapOf(
                "callState" to when (state) {
                    TelephonyManager.CALL_STATE_IDLE -> "idle"
                    TelephonyManager.CALL_STATE_RINGING -> "ringing"
                    TelephonyManager.CALL_STATE_OFFHOOK -> "offhook"
                    else -> "unknown"
                },
                "phoneType" to manager.phoneType,
                "simState" to manager.simState,
                "networkOperatorName" to manager.networkOperatorName,
                "networkCountryIso" to manager.networkCountryIso,
                "simCountryIso" to manager.simCountryIso,
            ),
        )
    }

    private fun callLogTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_get_call_log",
            description = "Read recent call-log entries after the owner grants Call Log permission.",
            inputSchema = objectSchema(
                "limit" to mapOf(
                    "type" to "integer",
                    "minimum" to 1,
                    "maximum" to 500,
                ),
            ),
        ),
    ) { args ->
        requirePermission(context, Manifest.permission.READ_CALL_LOG)
        val limit = ((args["limit"] as? Number)?.toInt() ?: 100).coerceIn(1, 500)
        val projection = arrayOf(
            CallLog.Calls._ID,
            CallLog.Calls.NUMBER,
            CallLog.Calls.CACHED_NAME,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
        )
        val entries = mutableListOf<Map<String, Any?>>()
        context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            projection,
            null,
            null,
            CallLog.Calls.DATE + " DESC",
        )?.use { cursor ->
            val id = cursor.getColumnIndexOrThrow(CallLog.Calls._ID)
            val number = cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
            val name = cursor.getColumnIndexOrThrow(CallLog.Calls.CACHED_NAME)
            val type = cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE)
            val date = cursor.getColumnIndexOrThrow(CallLog.Calls.DATE)
            val duration = cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION)
            while (cursor.moveToNext() && entries.size < limit) {
                entries += mapOf(
                    "id" to cursor.getLong(id),
                    "number" to cursor.getString(number),
                    "name" to cursor.getString(name),
                    "type" to cursor.getInt(type),
                    "date" to cursor.getLong(date),
                    "durationSeconds" to cursor.getLong(duration),
                )
            }
        }
        ToolResults.json(mapOf("count" to entries.size, "calls" to entries))
    }

    @Suppress("DEPRECATION")
    private fun answerCallTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_answer_call",
            description = "Answer a ringing call when Android grants ANSWER_PHONE_CALLS.",
            inputSchema = emptySchema(),
        ),
    ) {
        requirePermission(context, Manifest.permission.ANSWER_PHONE_CALLS)
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        telecom.acceptRingingCall()
        ToolResults.json(mapOf("requested" to true))
    }

    @Suppress("DEPRECATION")
    private fun endCallTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_end_call",
            description = "End the current call when Android grants ANSWER_PHONE_CALLS.",
            inputSchema = emptySchema(),
        ),
    ) {
        requirePermission(context, Manifest.permission.ANSWER_PHONE_CALLS)
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        ToolResults.json(mapOf("ended" to telecom.endCall()))
    }

    private fun readSmsTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_read_sms",
            description = "Read recent SMS messages after the owner grants SMS permission.",
            inputSchema = objectSchema(
                "limit" to mapOf(
                    "type" to "integer",
                    "minimum" to 1,
                    "maximum" to 1000,
                ),
            ),
        ),
    ) { args ->
        requirePermission(context, Manifest.permission.READ_SMS)
        val limit = ((args["limit"] as? Number)?.toInt() ?: 100).coerceIn(1, 1000)
        ToolResults.json(
            mapOf("messages" to querySms(context, null, emptyArray(), limit)),
        )
    }

    private fun searchSmsTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_search_sms",
            description = "Search SMS address/body text after the owner grants SMS permission.",
            inputSchema = objectSchema(
                "query" to mapOf("type" to "string", "minLength" to 1),
                "limit" to mapOf(
                    "type" to "integer",
                    "minimum" to 1,
                    "maximum" to 500,
                ),
            ),
        ),
    ) { args ->
        requirePermission(context, Manifest.permission.READ_SMS)
        val query = requireString(args, "query")
        val limit = ((args["limit"] as? Number)?.toInt() ?: 100).coerceIn(1, 500)
        val selection =
            "(" + Telephony.Sms.ADDRESS + " LIKE ? OR " + Telephony.Sms.BODY + " LIKE ?)"
        val pattern = "%$query%"
        ToolResults.json(
            mapOf(
                "query" to query,
                "messages" to querySms(
                    context,
                    selection,
                    arrayOf(pattern, pattern),
                    limit,
                ),
            ),
        )
    }

    @Suppress("DEPRECATION")
    private fun sendSmsTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_send_sms",
            description = "Send an SMS after the owner grants SEND_SMS and Android has an active SMS subscription.",
            inputSchema = objectSchema(
                "number" to mapOf("type" to "string", "minLength" to 1),
                "text" to mapOf("type" to "string"),
            ),
        ),
    ) { args ->
        requirePermission(context, Manifest.permission.SEND_SMS)
        val number = requireString(args, "number")
        val text = args["text"] as? String ?: error("text is required")
        require(text.isNotEmpty()) { "text must not be empty" }
        val manager = SmsManager.getDefault()
        val parts = manager.divideMessage(text)
        if (parts.size <= 1) {
            manager.sendTextMessage(number, null, text, null, null)
        } else {
            manager.sendMultipartTextMessage(
                number,
                null,
                ArrayList(parts),
                null,
                null,
            )
        }
        ToolResults.json(
            mapOf(
                "submitted" to true,
                "number" to number,
                "parts" to parts.size,
            ),
        )
    }

    private fun querySms(
        context: Context,
        selection: String?,
        selectionArgs: Array<String>,
        limit: Int,
    ): List<Map<String, Any?>> {
        val projection = arrayOf(
            Telephony.Sms._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
            Telephony.Sms.READ,
            Telephony.Sms.THREAD_ID,
        )
        val messages = mutableListOf<Map<String, Any?>>()
        context.contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            projection,
            selection,
            selectionArgs,
            Telephony.Sms.DATE + " DESC",
        )?.use { cursor ->
            val id = cursor.getColumnIndexOrThrow(Telephony.Sms._ID)
            val address = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
            val body = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
            val date = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
            val type = cursor.getColumnIndexOrThrow(Telephony.Sms.TYPE)
            val read = cursor.getColumnIndexOrThrow(Telephony.Sms.READ)
            val thread = cursor.getColumnIndexOrThrow(Telephony.Sms.THREAD_ID)
            while (cursor.moveToNext() && messages.size < limit) {
                messages += mapOf(
                    "id" to cursor.getLong(id),
                    "address" to cursor.getString(address),
                    "body" to cursor.getString(body),
                    "date" to cursor.getLong(date),
                    "type" to cursor.getInt(type),
                    "read" to (cursor.getInt(read) != 0),
                    "threadId" to cursor.getLong(thread),
                )
            }
        }
        return messages
    }

    private fun requirePermission(context: Context, permission: String) {
        require(context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            "Android permission not granted: $permission"
        }
    }

    private fun requireString(args: Map<String, Any?>, key: String): String =
        (args[key] as? String)?.takeIf { it.isNotBlank() }
            ?: error("$key is required")

    private fun numberSchema(): Map<String, Any?> =
        objectSchema("number" to mapOf("type" to "string", "minLength" to 1))

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
