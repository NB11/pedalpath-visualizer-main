// App State
let routes = [];
let map = null;
let addedRouteIds = []; // Track IDs of routes added to the map for cleanup
let selectedRoutes = new Set(); // Track which routes are selected
let isLoadingDefaultRoute = false; // Flag to track default route loading
const routeColors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

// Initialize Map with Maplibre GL JS
function initMap() {
    map = new maplibregl.Map({
        container: 'map',
        style: {
            version: 8,
            sources: {
                'osm-tiles': {
                    type: 'raster',
                    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                }
            },
            layers: [
                {
                    id: 'osm-tiles-layer',
                    type: 'raster',
                    source: 'osm-tiles',
                    minzoom: 0,
                    maxzoom: 19
                }
            ]
        },
        center: [9.670303613479033, 46.377728392437405], // [lng, lat] - Center of the route area
        zoom: 10, // Zoom level for the route area
        antialias: true // Smooth rendering
    });

    // Add navigation controls
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    // Wait for map to load AND style to load before loading default GPX
    map.on('load', function() {
        if (!map.isStyleLoaded()) {
            // If style isn't loaded yet, wait for it
            map.once('style.load', loadDefaultGPX);
        } else {
            // If style is already loaded, just run it
            loadDefaultGPX();
        }
    });
}

// GPX Parser
function parseGPX(gpxContent, fileName) {
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(gpxContent, 'text/xml');
        
        // Check for parsing errors
        const parserError = xmlDoc.querySelector('parsererror');
        if (parserError) {
            throw new Error('Invalid XML format');
        }

        const coordinates = [];
        const elevations = [];
        let routeName = fileName.replace('.gpx', '');

        // Extract name from metadata
        const metadataName = xmlDoc.querySelector('metadata > name');
        if (metadataName) {
            routeName = metadataName.textContent.trim();
        }

        // Process tracks
        const tracks = xmlDoc.querySelectorAll('trk');
        if (tracks.length > 0) {
            const track = tracks[0];
            const trackName = track.querySelector('name');
            if (trackName) {
                routeName = trackName.textContent.trim();
            }

            const segments = track.querySelectorAll('trkseg');
            segments.forEach(segment => {
                const points = segment.querySelectorAll('trkpt');
                points.forEach(point => {
                    const lat = parseFloat(point.getAttribute('lat'));
                    const lon = parseFloat(point.getAttribute('lon'));
                    
                    if (!isNaN(lat) && !isNaN(lon)) {
                        coordinates.push([lon, lat]);
                        
                        const ele = point.querySelector('ele');
                        if (ele) {
                            const elevation = parseFloat(ele.textContent);
                            if (!isNaN(elevation)) {
                                elevations.push(elevation);
                            }
                        }
                    }
                });
            });
        }

        // Process routes if no tracks found
        if (coordinates.length === 0) {
            const routes = xmlDoc.querySelectorAll('rte');
            if (routes.length > 0) {
                const route = routes[0];
                const routeNameEl = route.querySelector('name');
                if (routeNameEl) {
                    routeName = routeNameEl.textContent.trim();
                }

                const points = route.querySelectorAll('rtept');
                points.forEach(point => {
                    const lat = parseFloat(point.getAttribute('lat'));
                    const lon = parseFloat(point.getAttribute('lon'));
                    
                    if (!isNaN(lat) && !isNaN(lon)) {
                        coordinates.push([lon, lat]);
                        
                        const ele = point.querySelector('ele');
                        if (ele) {
                            const elevation = parseFloat(ele.textContent);
                            if (!isNaN(elevation)) {
                                elevations.push(elevation);
                            }
                        }
                    }
                });
            }
        }

        if (coordinates.length === 0) {
            return null;
        }

        // Calculate distance using Haversine formula
        function calculateDistance(coords) {
            let totalDistance = 0;
            const R = 6371000; // Earth's radius in meters
            
            for (let i = 1; i < coords.length; i++) {
                const [lon1, lat1] = coords[i - 1];
                const [lon2, lat2] = coords[i];
                
                const dLat = (lat2 - lat1) * Math.PI / 180;
                const dLon = (lon2 - lon1) * Math.PI / 180;
                const a = 
                    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
                    Math.sin(dLon / 2) * Math.sin(dLon / 2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                const distance = R * c;
                
                totalDistance += distance;
            }
            
            return totalDistance;
        }

        const distance = calculateDistance(coordinates);
        const maxElevation = elevations.length > 0 ? Math.max(...elevations) : undefined;

        return {
            id: `route-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            coordinates,
            name: routeName,
            distance,
            elevation: maxElevation
        };
    } catch (error) {
        console.error('Error parsing GPX:', error);
        throw error;
    }
}

// Format distance
function formatDistance(distance) {
    if (!distance) return 'N/A';
    return distance > 1000 
        ? `${(distance / 1000).toFixed(1)} km` 
        : `${Math.round(distance)} m`;
}

// Update Map with Routes
function updateMap() {
    if (!map) return;
    
    // Wait for map to be loaded and style ready before updating
    if (!map.loaded() || !map.isStyleLoaded()) {
        if (map.loaded()) {
            map.once('style.load', updateMap);
        } else {
            map.once('load', updateMap);
        }
        return;
    }

    // Clear existing routes
    addedRouteIds.forEach(routeId => {
        const layerId = `route-layer-${routeId}`;
        const sourceId = `route-${routeId}`;
        
        // IMPORTANT: Remove layer first, then source
        if (map.getLayer(layerId)) {
            map.removeLayer(layerId);
        }
        if (map.getSource(sourceId)) {
            map.removeSource(sourceId);
        }
    });
    addedRouteIds = []; // Clear the tracking array

    // Always hide placeholder - map should always be visible
    document.getElementById('map-placeholder').classList.add('hidden');

    const allBounds = [];
    
    routes.forEach((route, index) => {
        // Only show selected routes
        if (!selectedRoutes.has(route.id)) {
            return;
        }

        if (route.coordinates.length === 0) {
            return;
        }

        // Convert coordinates to GeoJSON format [lng, lat]
        const coordinates = route.coordinates.map(coord => [coord[0], coord[1]]);
        
        // Collect bounds
        coordinates.forEach(coord => {
            allBounds.push(coord);
        });

        // Create GeoJSON source
        const sourceId = `route-${route.id}`;
        const layerId = `route-layer-${route.id}`;
        
        try {
            // Remove source/layer if they already exist
            if (map.getLayer(layerId)) {
                map.removeLayer(layerId);
            }
            if (map.getSource(sourceId)) {
                map.removeSource(sourceId);
            }
            
            map.addSource(sourceId, {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates: coordinates
                    }
                }
            });

            // Add layer
            map.addLayer({
                id: layerId,
                type: 'line',
                source: sourceId,
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': routeColors[index % routeColors.length],
                    'line-width': 4,
                    'line-opacity': 1.0
                }
            });
        } catch (error) {
            console.error(`Error adding route ${route.id} to map:`, error);
        }

        // Add the route.id to our tracking array
        addedRouteIds.push(route.id);
    });

    // Fit map to show all selected routes (skip if loading default route)
    if (allBounds.length > 0 && !isLoadingDefaultRoute) {
        // Calculate bounds properly
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        
        allBounds.forEach(coord => {
            const [lng, lat] = coord;
            minLng = Math.min(minLng, lng);
            minLat = Math.min(minLat, lat);
            maxLng = Math.max(maxLng, lng);
            maxLat = Math.max(maxLat, lat);
        });
        
        const bounds = new maplibregl.LngLatBounds(
            [minLng, minLat],
            [maxLng, maxLat]
        );
        
        // Fit bounds with proper padding - adjust for better view
        map.fitBounds(bounds, {
            padding: { top: 100, bottom: 100, left: 100, right: 100 },
            duration: 2000,
            maxZoom: 14, // Don't zoom in too close
            linear: false // Use easeOut animation for smoother zoom
        });
    }
}

// Update UI
function updateUI() {
    // Update route list
    const routeList = document.getElementById('route-list');
    const routesCard = document.getElementById('routes-card');
    
    if (routes.length > 0) {
        routesCard.style.display = 'block';
        routeList.innerHTML = routes.map((route, index) => `
            <div class="route-item">
                <div class="route-info">
                    <div class="route-color" style="background-color: ${routeColors[index % routeColors.length]}"></div>
                    <div class="route-details">
                        <h4>${route.name}</h4>
                        <p>${formatDistance(route.distance)}${route.elevation ? ` • ${Math.round(route.elevation)}m elevation` : ''}</p>
                    </div>
                </div>
                <button class="btn-remove" onclick="removeRoute('${route.id}')">
                    <svg class="icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        `).join('');
    } else {
        routesCard.style.display = 'none';
    }

    // Update analytics - only calculate from selected routes
    const selectedRoutesList = routes.filter(route => selectedRoutes.has(route.id));
    const totalDistance = selectedRoutesList.reduce((sum, route) => sum + (route.distance || 0), 0);
    const totalRoutes = selectedRoutesList.length;
    const maxElevation = selectedRoutesList.reduce((max, route) => Math.max(max, route.elevation || 0), 0);

    document.getElementById('route-count').textContent = routes.length; // Total routes loaded
    document.getElementById('total-distance').textContent = formatDistance(totalDistance);
    document.getElementById('total-routes').textContent = totalRoutes; // Selected routes count

    if (maxElevation > 0) {
        document.getElementById('max-elevation-item').style.display = 'flex';
        document.getElementById('max-elevation').textContent = `${Math.round(maxElevation)}m`;
    } else {
        document.getElementById('max-elevation-item').style.display = 'none';
    }

    const statsCard = document.getElementById('stats-card');
    const emptyAnalyticsCard = document.getElementById('empty-analytics-card');
    const routeSelectorCard = document.getElementById('route-selector-card');
    const routeSelectorList = document.getElementById('route-selector-list');
    
    if (routes.length > 0) {
        routeSelectorCard.style.display = 'block';
        
        // Show stats only if there are selected routes
        if (totalRoutes > 0) {
            statsCard.style.display = 'block';
            emptyAnalyticsCard.style.display = 'none';
        } else {
            statsCard.style.display = 'none';
            emptyAnalyticsCard.style.display = 'block';
        }
        
        // Update route selector list
        routeSelectorList.innerHTML = routes.map((route, index) => {
            const isSelected = selectedRoutes.has(route.id);
            // Use HTML entity encoding for route.id to safely store in data attribute
            const encodedRouteId = route.id.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            return `
                <div class="route-selector-item ${isSelected ? 'selected' : ''}" data-route-id="${encodedRouteId}">
                    <div class="route-selector-checkbox">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                    <div class="route-selector-info">
                        <h4>${route.name}</h4>
                        <p>${formatDistance(route.distance)}${route.elevation ? ` • ${Math.round(route.elevation)}m elevation` : ''}</p>
                    </div>
                    <div class="route-color" style="background-color: ${routeColors[index % routeColors.length]}; width: 1rem; height: 1rem; border-radius: 50%; flex-shrink: 0;"></div>
                </div>
            `;
        }).join('');
    } else {
        statsCard.style.display = 'none';
        routeSelectorCard.style.display = 'none';
        emptyAnalyticsCard.style.display = 'block';
    }
}

// Toggle Route Selection
function toggleRouteSelection(routeId) {
    if (selectedRoutes.has(routeId)) {
        selectedRoutes.delete(routeId);
    } else {
        selectedRoutes.add(routeId);
    }
    
    updateMap();
    updateUI();
}

// Handle File Upload
async function handleFileUpload(files) {
    const browseText = document.getElementById('browse-text');
    browseText.textContent = 'Loading...';
    
    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            
            if (!file.name.toLowerCase().endsWith('.gpx')) {
                alert(`${file.name} is not a GPX file`);
                continue;
            }

            const text = await file.text();
            const parsedRoute = parseGPX(text, file.name);
            
            if (parsedRoute) {
                routes.push(parsedRoute);
                // Automatically select new routes
                selectedRoutes.add(parsedRoute.id);
            }
        }

        updateMap();
        updateUI();
    } catch (error) {
        alert('Error loading GPX file. Please check the file format and try again.');
        console.error(error);
    } finally {
        browseText.textContent = 'Browse Files';
    }
}

// Remove Route
function removeRoute(routeId) {
    routes = routes.filter(route => route.id !== routeId);
    selectedRoutes.delete(routeId);
    updateMap();
    updateUI();
}

// Tab Switching
document.querySelectorAll('.tab-trigger').forEach(trigger => {
    trigger.addEventListener('click', () => {
        const tabName = trigger.dataset.tab;
        
        // Update active tab
        document.querySelectorAll('.tab-trigger').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        
        trigger.classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');
    });
});

// File Input Handlers
const fileInput = document.getElementById('file-input');
const uploadArea = document.getElementById('upload-area');
const browseBtn = document.getElementById('browse-btn');

browseBtn.addEventListener('click', () => {
    fileInput.click();
});

uploadArea.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
        handleFileUpload(e.target.files);
    }
});

// Drag and Drop
uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFileUpload(e.dataTransfer.files);
    }
});

// Load Default GPX Files
async function loadDefaultGPX() {
    const defaultFiles = [
        'sample_gpx/2025-06-27_2320624248_Velotour.gpx',
        'sample_gpx/2025-06-27_2320622316_Velotour - Thusis - Samaden.gpx'
    ];
    
    // Set flag to skip fitBounds *inside* updateMap
    isLoadingDefaultRoute = true;
    
    try {
        // 1. Load all GPX files and select them
        for (const filePath of defaultFiles) {
            try {
                const response = await fetch(filePath);
                if (!response.ok) {
                    console.warn(`Default GPX file not found: ${filePath}, skipping...`);
                    continue;
                }
                const gpxContent = await response.text();
                const fileName = filePath.split('/').pop();
                const parsedRoute = parseGPX(gpxContent, fileName);
                
                if (parsedRoute) {
                    routes.push(parsedRoute);
                    // Automatically select all default routes
                    selectedRoutes.add(parsedRoute.id);
                    console.log(`Loaded default route: ${parsedRoute.name} (ID: ${parsedRoute.id})`);
                }
            } catch (error) {
                console.error(`Error loading default GPX file ${filePath}:`, error);
            }
        }
        
        // 2. Update the UI (Checkboxes will now be checked)
        updateUI();
        
        // 3. Update the Map (Layers will be drawn)
        // We can call this directly. We know the map is ready.
        updateMap();
        
        // 4. Manually fit bounds *after* a 'tick' (setTimeout 0)
        // This yields to the event loop, letting the map
        // process the updateMap() call before we animate the zoom.
        setTimeout(() => {
            if (map && map.loaded() && routes.length > 0) {
                const allBounds = [];
                routes.forEach(route => {
                    if (selectedRoutes.has(route.id) && route.coordinates.length > 0) {
                        route.coordinates.forEach(coord => {
                            allBounds.push(coord);
                        });
                    }
                });
                
                if (allBounds.length > 0) {
                    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
                    allBounds.forEach(coord => {
                        const [lng, lat] = coord;
                        minLng = Math.min(minLng, lng);
                        minLat = Math.min(minLat, lat);
                        maxLng = Math.max(maxLng, lng);
                        maxLat = Math.max(maxLat, lat);
                    });
                    
                    const bounds = new maplibregl.LngLatBounds(
                        [minLng, minLat],
                        [maxLng, maxLat]
                    );
                    
                    map.fitBounds(bounds, {
                        padding: { top: 100, bottom: 100, left: 100, right: 100 },
                        duration: 1500, // Animate the zoom
                        maxZoom: 14
                    });
                }
            }
        }, 0); // A 0ms timeout is all that's needed.
        
        // DEBUG: Toggle routes off after 2 seconds to verify they were visible
        setTimeout(() => {
            console.log('DEBUG: Toggling routes off after 2 seconds');
            const routeIds = Array.from(selectedRoutes);
            routeIds.forEach(routeId => {
                selectedRoutes.delete(routeId);
            });
            updateMap();
            updateUI();
            console.log('DEBUG: Routes toggled off. Check if they were visible before this.');
            
            // DEBUG: Toggle routes back on after another 2 seconds (4 seconds total)
            setTimeout(() => {
                console.log('DEBUG: Toggling routes back ON after 4 seconds total');
                // Get all route IDs from the routes array
                routes.forEach(route => {
                    selectedRoutes.add(route.id);
                });
                updateMap();
                updateUI();
                console.log('DEBUG: Routes toggled back on.');
            }, 1000);
        }, 1000);
        
    } catch (error) {
        console.error('Error in loadDefaultGPX:', error);
    } finally {
        // 5. Reset the flag immediately (don't wait for the timeout)
        isLoadingDefaultRoute = false;
    }
}

// Event Delegation for Route Selector
// Use document-level delegation to handle dynamically created elements
document.addEventListener('click', function(e) {
    const item = e.target.closest('.route-selector-item');
    if (item) {
        const routeId = item.getAttribute('data-route-id');
        if (routeId) {
            // Decode HTML entities back to original route ID
            const decodedRouteId = routeId.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
            toggleRouteSelection(decodedRouteId);
        }
    }
});

// Initialize App
initMap();

