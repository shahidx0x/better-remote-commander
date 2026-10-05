package io.github.shahidx0x.brc.android.contacts

import android.Manifest
import android.content.ContentProviderOperation
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults

object ContactToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(listContactsTool(app))
            .register(searchContactsTool(app))
            .register(createContactTool(app))
    }

    private fun listContactsTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_get_contacts",
            description = "List contacts and phone numbers after the owner grants Contacts permission.",
            inputSchema = objectSchema(
                "limit" to mapOf(
                    "type" to "integer",
                    "minimum" to 1,
                    "maximum" to 1000,
                ),
            ),
        ),
    ) { args ->
        requirePermission(context, Manifest.permission.READ_CONTACTS)
        val limit = ((args["limit"] as? Number)?.toInt() ?: 200).coerceIn(1, 1000)
        ToolResults.json(
            mapOf(
                "contacts" to queryContacts(context, null, emptyArray(), limit),
            ),
        )
    }

    private fun searchContactsTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_search_contacts",
            description = "Search contacts by display name or phone number.",
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
        requirePermission(context, Manifest.permission.READ_CONTACTS)
        val query = (args["query"] as? String)?.takeIf { it.isNotBlank() }
            ?: error("query is required")
        val limit = ((args["limit"] as? Number)?.toInt() ?: 100).coerceIn(1, 500)
        val selection =
            "(" + ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ? OR " +
                ContactsContract.CommonDataKinds.Phone.NUMBER + " LIKE ?)"
        val pattern = "%$query%"
        ToolResults.json(
            mapOf(
                "query" to query,
                "contacts" to queryContacts(
                    context,
                    selection,
                    arrayOf(pattern, pattern),
                    limit,
                ),
            ),
        )
    }

    private fun createContactTool(context: Context) = FunctionTool(
        ToolDefinition(
            name = "android_create_contact",
            description = "Create a contact with a name and optional phone/email after Contacts write permission is granted.",
            inputSchema = objectSchema(
                "name" to mapOf("type" to "string", "minLength" to 1),
                "phone" to mapOf("type" to "string"),
                "email" to mapOf("type" to "string"),
            ),
        ),
    ) { args ->
        requirePermission(context, Manifest.permission.WRITE_CONTACTS)
        val name = (args["name"] as? String)?.takeIf { it.isNotBlank() }
            ?: error("name is required")
        val phone = (args["phone"] as? String)?.takeIf { it.isNotBlank() }
        val email = (args["email"] as? String)?.takeIf { it.isNotBlank() }

        val operations = arrayListOf<ContentProviderOperation>()
        operations += ContentProviderOperation.newInsert(
            ContactsContract.RawContacts.CONTENT_URI,
        )
            .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
            .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
            .build()

        operations += ContentProviderOperation.newInsert(
            ContactsContract.Data.CONTENT_URI,
        )
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
            .withValue(
                ContactsContract.Data.MIMETYPE,
                ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
            )
            .withValue(
                ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME,
                name,
            )
            .build()

        if (phone != null) {
            operations += ContentProviderOperation.newInsert(
                ContactsContract.Data.CONTENT_URI,
            )
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
                )
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
                .withValue(
                    ContactsContract.CommonDataKinds.Phone.TYPE,
                    ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE,
                )
                .build()
        }

        if (email != null) {
            operations += ContentProviderOperation.newInsert(
                ContactsContract.Data.CONTENT_URI,
            )
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
                )
                .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, email)
                .withValue(
                    ContactsContract.CommonDataKinds.Email.TYPE,
                    ContactsContract.CommonDataKinds.Email.TYPE_OTHER,
                )
                .build()
        }

        val results = context.contentResolver.applyBatch(
            ContactsContract.AUTHORITY,
            operations,
        )
        ToolResults.json(
            mapOf(
                "created" to true,
                "name" to name,
                "phone" to phone,
                "email" to email,
                "rawContactUri" to results.firstOrNull()?.uri?.toString(),
            ),
        )
    }

    private fun queryContacts(
        context: Context,
        selection: String?,
        selectionArgs: Array<String>,
        limit: Int,
    ): List<Map<String, Any?>> {
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.TYPE,
            ContactsContract.CommonDataKinds.Phone.LABEL,
        )
        val results = mutableListOf<Map<String, Any?>>()
        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            projection,
            selection,
            selectionArgs,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME +
                " COLLATE NOCASE ASC",
        )?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(
                ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            )
            val nameIndex = cursor.getColumnIndexOrThrow(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            )
            val numberIndex = cursor.getColumnIndexOrThrow(
                ContactsContract.CommonDataKinds.Phone.NUMBER,
            )
            val typeIndex = cursor.getColumnIndexOrThrow(
                ContactsContract.CommonDataKinds.Phone.TYPE,
            )
            val labelIndex = cursor.getColumnIndexOrThrow(
                ContactsContract.CommonDataKinds.Phone.LABEL,
            )
            while (cursor.moveToNext() && results.size < limit) {
                results += linkedMapOf(
                    "contactId" to cursor.getLong(idIndex),
                    "name" to cursor.getString(nameIndex),
                    "number" to cursor.getString(numberIndex),
                    "type" to cursor.getInt(typeIndex),
                    "label" to cursor.getString(labelIndex),
                )
            }
        }
        return results
    }

    private fun requirePermission(context: Context, permission: String) {
        require(context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            "Android permission not granted: $permission"
        }
    }

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
