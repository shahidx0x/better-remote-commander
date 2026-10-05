package io.github.shahidx0x.brc.android.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import io.github.shahidx0x.brc.android.protocol.ToolDefinition
import io.github.shahidx0x.brc.android.tools.FunctionTool
import io.github.shahidx0x.brc.android.tools.ToolRegistry
import io.github.shahidx0x.brc.android.tools.ToolResults
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

object LocationToolProvider {
    fun register(context: Context, registry: ToolRegistry) {
        val app = context.applicationContext
        registry
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_get_location",
                        description = "Return the current or most recent Android location after the owner grants location permission.",
                        inputSchema = objectSchema(
                            "fresh" to mapOf("type" to "boolean"),
                            "timeoutMs" to mapOf(
                                "type" to "integer",
                                "minimum" to 1000,
                                "maximum" to 20000,
                            ),
                        ),
                    ),
                ) { args ->
                    requireLocationPermission(app)
                    val fresh = args["fresh"] as? Boolean ?: true
                    val timeout = ((args["timeoutMs"] as? Number)?.toLong() ?: 8000L)
                        .coerceIn(1000L, 20_000L)
                    val manager = app.getSystemService(Context.LOCATION_SERVICE)
                        as LocationManager
                    val location = if (fresh && Build.VERSION.SDK_INT >= 30) {
                        currentLocation(manager, timeout) ?: lastLocation(manager)
                    } else {
                        lastLocation(manager)
                    }
                    if (location == null) {
                        ToolResults.json(
                            mapOf(
                                "available" to false,
                                "providers" to enabledProviders(manager),
                            ),
                        )
                    } else {
                        ToolResults.json(locationMap(location))
                    }
                },
            )
            .register(
                FunctionTool(
                    ToolDefinition(
                        name = "android_location_providers",
                        description = "Return Android location provider availability.",
                        inputSchema = emptySchema(),
                    ),
                ) {
                    requireLocationPermission(app)
                    val manager = app.getSystemService(Context.LOCATION_SERVICE)
                        as LocationManager
                    ToolResults.json(
                        mapOf(
                            "locationEnabled" to manager.isLocationEnabled,
                            "providers" to enabledProviders(manager),
                        ),
                    )
                },
            )
    }

    private fun currentLocation(
        manager: LocationManager,
        timeoutMs: Long,
    ): Location? {
        if (Build.VERSION.SDK_INT < 30) return null
        val provider = candidateProviders(manager)
            .firstOrNull { manager.isProviderEnabled(it) } ?: return null

        val latch = CountDownLatch(1)
        val result = AtomicReference<Location?>()
        val executor = Executors.newSingleThreadExecutor()
        val cancellation = CancellationSignal()
        try {
            manager.getCurrentLocation(
                provider,
                cancellation,
                executor,
            ) {
                result.set(it)
                latch.countDown()
            }
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
            cancellation.cancel()
            return result.get()
        } finally {
            executor.shutdownNow()
        }
    }

    @Suppress("MissingPermission")
    private fun lastLocation(manager: LocationManager): Location? =
        candidateProviders(manager)
            .filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
            .mapNotNull { provider ->
                runCatching { manager.getLastKnownLocation(provider) }.getOrNull()
            }
            .maxByOrNull(Location::getTime)

    private fun candidateProviders(manager: LocationManager): List<String> =
        (
            listOf(
                LocationManager.GPS_PROVIDER,
                LocationManager.NETWORK_PROVIDER,
                LocationManager.PASSIVE_PROVIDER,
            ) + manager.allProviders
        ).distinct()

    private fun enabledProviders(manager: LocationManager): List<Map<String, Any?>> =
        manager.allProviders.map { provider ->
            mapOf(
                "name" to provider,
                "enabled" to runCatching {
                    manager.isProviderEnabled(provider)
                }.getOrDefault(false),
            )
        }

    private fun locationMap(location: Location): Map<String, Any?> =
        linkedMapOf(
            "available" to true,
            "provider" to location.provider,
            "latitude" to location.latitude,
            "longitude" to location.longitude,
            "accuracyMeters" to if (location.hasAccuracy()) location.accuracy else null,
            "altitudeMeters" to if (location.hasAltitude()) location.altitude else null,
            "bearingDegrees" to if (location.hasBearing()) location.bearing else null,
            "speedMps" to if (location.hasSpeed()) location.speed else null,
            "timeMs" to location.time,
            "elapsedRealtimeNanos" to location.elapsedRealtimeNanos,
            "mock" to if (Build.VERSION.SDK_INT >= 31) {
                location.isMock
            } else {
                @Suppress("DEPRECATION")
                location.isFromMockProvider
            },
        )

    private fun requireLocationPermission(context: Context) {
        val fine =
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
        val coarse =
            context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
        require(fine || coarse) {
            "Android location permission is not granted."
        }
    }

    private fun emptySchema(): Map<String, Any?> =
        mapOf("type" to "object", "properties" to emptyMap<String, Any?>())

    private fun objectSchema(
        vararg properties: Pair<String, Map<String, Any?>>,
    ): Map<String, Any?> =
        mapOf("type" to "object", "properties" to mapOf(*properties))
}
