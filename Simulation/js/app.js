const { createApp } = Vue

createApp({
    data() {
        return {
            map: null,
            startDate: new Date('2025-05-01'),
            endDate: new Date('2025-10-01'),
            startDateInput: '2025-05-01',
            endDateInput: '2025-10-01',
            currentTime: new Date('2025-05-01').getTime(),
            isPlaying: false,
            animationFrame: null,
            observationDensity: 1,
            taxonomicalLikelihood: 1,
            observationPoints: [],
            currentPoints: [],
            detectedPoints: new Set(),
            allDetections: new Map(),
            simulationComplete: false,
            totalObservationCount: 0,
            processedPoints: new Set(),
            customBoundary: null,
            isComputing: false,
            simulationResults: null,
            computationProgress: 0,
            bounds: {
                minLng: -79.76195572267673,
                maxLng: -71.66878968312145,
                minLat: 40.476578082629224,
                maxLat: 45.015870524557556
            },
            updateTimeout: null,
            isDragging: false,
            isPrecompiling: false,
            precompileProgress: 0,
            hasPrecompiledResults: false,
            startTime: 0,
            defaultBoundaryLoaded: false,
            uploadInstructions: 'Choose a GeoJSON file to define a custom boundary area (optional - defaults to NY state)',
            isGeneratingPoints: false,
            pointGenerationProgress: 0
        }
    },
    computed: {
        detectionRate() {
            if (this.totalObservationCount === 0) return 0;
            return ((this.detectedPoints.size / this.totalObservationCount) * 100).toFixed(1);
        },
        getPlayButtonText() {
            if (this.isGeneratingPoints) return 'Generating Points...';
            if (this.isPrecompiling) return 'Preparing Simulation...';
            if (this.isPlaying) return 'Pause';
            return 'Play';
        }
    },
    mounted: async function() {
        try {
            this.map = new maplibregl.Map({
                container: 'map',
                style: 'https://demotiles.maplibre.org/style.json',
                center: [-75.6, 42.9],
                zoom: 6
            });

            // Wait for map to load
            await new Promise((resolve, reject) => {
                this.map.on('load', resolve);
                this.map.on('error', reject);
            });

            // Load default boundary
            const response = await fetch('./data/ny_state_boundary.geojson');
            if (!response.ok) throw new Error('Failed to load default boundary');
            
            const geojsonData = await response.json();
            this.customBoundary = geojsonData;
            this.defaultBoundaryLoaded = true;

            // Add boundary to map
            this.map.addSource('boundary', {
                type: 'geojson',
                data: this.customBoundary
            });

            // Add progress overlay source
            this.map.addSource('progress-overlay', {
                type: 'geojson',
                data: this.calculateProgressPolygon(0)
            });

            // Add observation points source
            this.map.addSource('observation-points', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });

            // Add detected points source
            this.map.addSource('detected-points', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });

            // Add map layers
            this.map.addLayer({
                id: 'boundary-fill',
                type: 'fill',
                source: 'boundary',
                paint: {
                    'fill-color': '#088',
                    'fill-opacity': 0.2
                }
            });

            this.map.addLayer({
                id: 'boundary-line',
                type: 'line',
                source: 'boundary',
                paint: {
                    'line-color': '#088',
                    'line-width': 2
                }
            });

            // Add progress overlay layer
            this.map.addLayer({
                id: 'progress-overlay',
                type: 'fill',
                source: 'progress-overlay',
                paint: {
                    'fill-color': '#ff0000',
                    'fill-opacity': 0.2
                }
            });

            // Add observation points layer
            this.map.addLayer({
                id: 'observation-points',
                type: 'circle',
                source: 'observation-points',
                paint: {
                    'circle-radius': 4,
                    'circle-color': '#666',
                    'circle-opacity': 0.7,
                    // Add a pulse effect
                    'circle-radius-transition': {duration: 1000},
                    'circle-opacity-transition': {duration: 1000}
                }
            });

            // Add detected points layer
            this.map.addLayer({
                id: 'detected-points',
                type: 'circle',
                source: 'detected-points',
                paint: {
                    'circle-radius': 6,
                    'circle-color': '#ff0000',
                    'circle-opacity': 0.9,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff'
                }
            });

            this.generatePotentialPoints();

        } catch (error) {
            console.error('Error in mounted:', error);
        }
    },
    methods: {
        calculateProgressPolygon(progress) {
            if (!this.bounds) return null;
            
            // Calculate the longitude where the pest has spread to
            const spreadLng = this.bounds.minLng + ((this.bounds.maxLng - this.bounds.minLng) * progress);
            
            return {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [this.bounds.minLng, this.bounds.minLat],
                        [spreadLng, this.bounds.minLat],
                        [spreadLng, this.bounds.maxLat],
                        [this.bounds.minLng, this.bounds.maxLat],
                        [this.bounds.minLng, this.bounds.minLat]
                    ]]
                }
            };
        },
        formatDate(date) {
            return date.toLocaleDateString();
        },
        updateProgress() {
            if (!this.map) return;
            
            // Throttle updates to every 100ms
            if (this._updateThrottle) return;
            this._updateThrottle = setTimeout(() => {
                this._updateThrottle = null;
            }, 100);
            
            const totalDuration = this.endDate.getTime() - this.startDate.getTime();
            const currentProgress = (this.currentTime - this.startDate.getTime()) / totalDuration;
            
            // Batch map source updates
            const updates = {
                progress: this.calculateProgressPolygon(currentProgress),
                currentPoints: [],
                detectedPoints: []
            };

            // Filter points more efficiently
            const timeWindow = 2 * 24 * 60 * 60 * 1000;
            const minTime = this.currentTime - timeWindow;
            const newPoints = [];
            
            // Binary search for start index
            let startIdx = this.binarySearchPoints(this.observationPoints, minTime);
            let endIdx = this.binarySearchPoints(this.observationPoints, this.currentTime);

            // Process only points within the time window
            for (let i = startIdx; i <= endIdx && i < this.observationPoints.length; i++) {
                const point = this.observationPoints[i];
                if (point.properties.timestamp <= this.currentTime && 
                    point.properties.timestamp > minTime) {
                    newPoints.push(point);
                }
            }

            // Count new points efficiently
            for (const point of newPoints) {
                if (!this.processedPoints.has(point.properties.id)) {
                    this.totalObservationCount++;
                    this.processedPoints.add(point.properties.id);
                }
            }

            // Update current points
            this.currentPoints = newPoints;

            // Batch update map sources
            if (this.map.getSource('progress-overlay')) {
                this.map.getSource('progress-overlay').setData(updates.progress);
            }

            const currentFeatures = {
                type: 'FeatureCollection',
                features: this.currentPoints
            };

            if (this.map.getSource('observation-points')) {
                this.map.getSource('observation-points').setData(currentFeatures);
            }

            this.checkDetections(currentProgress);
        },
        binarySearchPoints(points, timestamp) {
            let left = 0;
            let right = points.length - 1;
            
            while (left <= right) {
                const mid = Math.floor((left + right) / 2);
                const midTime = points[mid].properties.timestamp;
                
                if (midTime === timestamp) {
                    return mid;
                } else if (midTime < timestamp) {
                    left = mid + 1;
                } else {
                    right = mid - 1;
                }
            }
            
            return left;
        },
        checkDetections(progress) {
            // Check only current points that haven't been evaluated
            const newPoints = this.currentPoints.filter(point => 
                !this.allDetections.has(point.properties.id)
            );

            // Calculate the current spread longitude
            const spreadLng = this.bounds.minLng + ((this.bounds.maxLng - this.bounds.minLng) * progress);

            // Check new points for detection
            newPoints.forEach(point => {
                const isInSpreadArea = point.geometry.coordinates[0] <= spreadLng;
                const isDetected = isInSpreadArea && (Math.random() * 100 <= this.taxonomicalLikelihood);

                // Store the detection result with its timestamp
                this.allDetections.set(point.properties.id, {
                    isDetected,
                    timestamp: point.properties.timestamp
                });
            });

            // Update current detections based on time
            this.detectedPoints = new Set(
                Array.from(this.allDetections.entries())
                    .filter(([_, data]) => 
                        data.isDetected && data.timestamp <= this.currentTime
                    )
                    .map(([id, _]) => id)
            );

            // Update detected points on map
            if (this.map.getSource('detected-points')) {
                const detectedFeatures = this.observationPoints.filter(point => 
                    this.detectedPoints.has(point.properties.id)
                );

                this.map.getSource('detected-points').setData({
                    type: 'FeatureCollection',
                    features: detectedFeatures
                });
            }
        },
        async toggleAnimation() {
            // Don't allow restart if complete - must reset first
            if (this.simulationComplete && !this.isPlaying) {
                return;
            }

            if (this.isPlaying) {
                // If already playing, just pause
                this.isPlaying = false;
                cancelAnimationFrame(this.animationFrame);
                return;
            }

            // Generate points if we haven't yet
            if (this.observationPoints.length === 0) {
                this.isGeneratingPoints = true;
                await this.generatePotentialPoints();
            }

            // If we don't have precompiled results, do that first
            if (!this.hasPrecompiledResults) {
                await this.precomputeSimulation();
            }

            this.isPlaying = true;
            this.playPrecomputedSimulation();
        },
        animate() {
            if (!this.isPlaying) return;

            const now = performance.now();
            if (!this._lastAnimationTime) {
                this._lastAnimationTime = now;
            }

            const elapsed = now - this._lastAnimationTime;
            if (elapsed > 16) { // Cap at ~60fps
                const step = 43200000; // Half day in milliseconds
                this.currentTime += step;
                this._lastAnimationTime = now;

                if (this.currentTime > this.endDate.getTime()) {
                    this.isPlaying = false;
                    this.simulationComplete = true;
                    this.currentTime = this.endDate.getTime();
                    return;
                }

                this.updateProgress();
            }
            
            this.animationFrame = requestAnimationFrame(() => this.animate());
        },
        updateDateRange() {
            const newStartDate = new Date(this.startDateInput);
            const newEndDate = new Date(this.endDateInput);
            
            // Update the dates without validation
            this.startDate = newStartDate;
            this.endDate = newEndDate;
            this.currentTime = newStartDate.getTime();
            
            // If animation is playing, stop it
            if (this.isPlaying) {
                this.toggleAnimation();
            }
            
            this.updateProgress();
        },
        updateParameters() {
            // Immediately update the UI value
            if (this.updateTimeout) {
                clearTimeout(this.updateTimeout);
            }

            // Only reset simulation after user stops dragging
            this.updateTimeout = setTimeout(() => {
                this.resetSimulation();
            }, 300); // Wait 300ms after last change before updating
        },
        handleSliderStart() {
            this.isDragging = true;
            if (this.isPlaying) {
                this.toggleAnimation(); // Pause if playing
            }
        },
        handleSliderEnd() {
            this.isDragging = false;
            this.resetSimulation();
        },
        generatePotentialPoints() {
            return new Promise((resolve) => {
                if (!this.customBoundary || !this.customBoundary.features) {
                    console.error('Invalid boundary data');
                    this.isGeneratingPoints = false;
                    resolve();
                    return;
                }

                this.pointGenerationProgress = 0;
                this.observationPoints = [];
                const polygon = this.customBoundary.features[0];
                const bbox = turf.bbox(polygon);
                
                // Calculate point count based on area and density
                const area = turf.area(polygon) / 1000000; // Convert to km²
                const monthsInSimulation = (this.endDate - this.startDate) / (1000 * 60 * 60 * 24 * 30);
                const pointCount = Math.round(area * this.observationDensity * monthsInSimulation);
                
                let validPoints = 0;

                const generateChunk = () => {
                    const chunkSize = 100;
                    let pointsInChunk = 0;

                    while (pointsInChunk < chunkSize && validPoints < pointCount) {
                        const point = turf.randomPosition(bbox);
                        if (turf.booleanPointInPolygon(point, polygon)) {
                            const timestamp = this.startDate.getTime() + 
                                Math.random() * (this.endDate.getTime() - this.startDate.getTime());
                            
                            this.observationPoints.push({
                                type: 'Feature',
                                geometry: {
                                    type: 'Point',
                                    coordinates: point
                                },
                                properties: {
                                    id: validPoints.toString(),
                                    timestamp: timestamp
                                }
                            });
                            validPoints++;
                            pointsInChunk++;
                        }
                    }

                    this.pointGenerationProgress = (validPoints / pointCount) * 100;

                    if (validPoints < pointCount) {
                        setTimeout(generateChunk, 0);
                    } else {
                        this.observationPoints.sort((a, b) => a.properties.timestamp - b.properties.timestamp);
                        this.isGeneratingPoints = false;
                        resolve();
                    }
                };

                generateChunk();
            });
        },
        resetSimulation(generatePoints = true) {
            if (this.isPlaying) {
                this.isPlaying = false;
                cancelAnimationFrame(this.animationFrame);
            }

            this.currentTime = this.startDate.getTime();
            this.observationPoints = [];
            this.currentPoints = [];
            this.detectedPoints = new Set();
            this.allDetections = new Map();
            this.totalObservationCount = 0;
            this.processedPoints = new Set();
            this.simulationComplete = false;

            if (this.map) {
                const progressSource = this.map.getSource('progress-overlay');
                if (progressSource) {
                    progressSource.setData(this.calculateProgressPolygon(0));
                }

                const observationSource = this.map.getSource('observation-points');
                if (observationSource) {
                    observationSource.setData({
                        type: 'FeatureCollection',
                        features: []
                    });
                }

                const detectedSource = this.map.getSource('detected-points');
                if (detectedSource) {
                    detectedSource.setData({
                        type: 'FeatureCollection',
                        features: []
                    });
                }
            }

            if (generatePoints) {
                this.generatePotentialPoints();
            }
        },
        fixPolygonWinding(geojson) {
            const isClockwise = coords => {
                let sum = 0;
                for (let i = 0; i < coords.length - 1; i++) {
                    sum += (coords[i + 1][0] - coords[i][0]) * (coords[i + 1][1] + coords[i][1]);
                }
                return sum > 0;
            };

            const reverseCoords = coords => {
                if (Array.isArray(coords[0][0])) {
                    return coords.map(reverseCoords);
                }
                return coords.reverse();
            };

            geojson.features.forEach(feature => {
                if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
                    const coords = feature.geometry.coordinates;
                    if (feature.geometry.type === 'Polygon') {
                        if (isClockwise(coords[0])) {
                            feature.geometry.coordinates = reverseCoords(coords);
                        }
                    } else {
                        coords.forEach((poly, i) => {
                            if (isClockwise(poly[0])) {
                                feature.geometry.coordinates[i] = reverseCoords(poly);
                            }
                        });
                    }
                }
            });

            return geojson;
        },
        async handleFileUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            try {
                const reader = new FileReader();
                const fileContent = await new Promise((resolve, reject) => {
                    reader.onload = e => resolve(e.target.result);
                    reader.onerror = reject;
                    reader.readAsText(file);
                });

                // Parse and validate GeoJSON
                const geojsonData = JSON.parse(fileContent);
                if (!geojsonData.type || !geojsonData.features) {
                    throw new Error('Invalid GeoJSON format');
                }

                this.customBoundary = this.fixPolygonWinding(geojsonData);
                
                // Update the map with the new boundary
                if (this.map.getSource('boundary')) {
                    this.map.getSource('boundary').setData(this.customBoundary);
                }

                // Fit map to boundary
                const bbox = turf.bbox(this.customBoundary);
                this.map.fitBounds([
                    [bbox[0], bbox[1]],
                    [bbox[2], bbox[3]]
                ], { padding: 50 });

                // Update bounds based on new boundary
                this.bounds = this.calculateBoundsFromGeoJSON(this.customBoundary);

                // Reset simulation state
                this.resetSimulation(false); // Don't generate points yet

            } catch (error) {
                console.error('Error loading file:', error);
                alert('Error loading boundary file: ' + error.message);
            }

            // Clear the file input so the same file can be selected again
            event.target.value = '';
        },
        calculateBoundsFromGeoJSON(geojson) {
            let minLng = Infinity, maxLng = -Infinity;
            let minLat = Infinity, maxLat = -Infinity;

            const processCoords = coords => {
                if (!coords) return;
                
                if (Array.isArray(coords[0])) {
                    coords.forEach(processCoords);
                } else if (coords.length >= 2) {  // Make sure we have at least [lng, lat]
                    minLng = Math.min(minLng, coords[0]);
                    maxLng = Math.max(maxLng, coords[0]);
                    minLat = Math.min(minLat, coords[1]);
                    maxLat = Math.max(maxLat, coords[1]);
                }
            };

            try {
                if (geojson.features && Array.isArray(geojson.features)) {
                    geojson.features.forEach(feature => {
                        if (feature && feature.geometry && feature.geometry.coordinates) {
                            processCoords(feature.geometry.coordinates);
                        }
                    });
                } else if (geojson.geometry && geojson.geometry.coordinates) {
                    processCoords(geojson.geometry.coordinates);
                }

                // Check if we found any valid coordinates
                if (minLng === Infinity || maxLng === -Infinity || 
                    minLat === Infinity || maxLat === -Infinity) {
                    throw new Error('No valid coordinates found in GeoJSON');
                }

                return { minLng, maxLng, minLat, maxLat };
            } catch (error) {
                console.error('Error processing GeoJSON bounds:', error);
                // Return a default bounding box (e.g., New York State)
                return {
                    minLng: -79.762152,
                    maxLng: -71.856214,
                    minLat: 40.496103,
                    maxLat: 45.015851
                };
            }
        },
        async precomputeSimulation() {
            this.isPrecompiling = true;
            this.precompileProgress = 0;
            
            try {
                console.log('Starting precomputation...');
                
                // Create worker with correct relative path
                const worker = new Worker('./js/simulation-worker.js');
                
                worker.onmessage = (e) => {
                    if (e.data.type === 'error') {
                        console.error('Worker reported error:', e.data.error);
                        this.isPrecompiling = false;
                        alert('Simulation error: ' + e.data.error);
                        return;
                    }
                    
                    if (e.data.type === 'progress') {
                        console.log('Progress update:', e.data.progress);
                        this.precompileProgress = e.data.progress;
                    } else if (e.data.type === 'complete') {
                        console.log('Simulation complete, processing results...');
                        this.simulationResults = e.data.results;
                        this.isPrecompiling = false;
                        this.hasPrecompiledResults = true;
                        this.playPrecomputedSimulation();
                    }
                };

                worker.onerror = (error) => {
                    console.error('Worker error event:', error);
                    this.isPrecompiling = false;
                    worker.terminate();
                    alert('Simulation error: ' + error.message);
                };

                // Prepare serializable data for the worker
                const workerData = {
                    startDate: this.startDate.getTime(),
                    endDate: this.endDate.getTime(),
                    bounds: {
                        minLng: Number(this.bounds.minLng),
                        maxLng: Number(this.bounds.maxLng),
                        minLat: Number(this.bounds.minLat),
                        maxLat: Number(this.bounds.maxLat)
                    },
                    taxonomicalLikelihood: Number(this.taxonomicalLikelihood),
                    observationPoints: this.observationPoints.map(point => ({
                        id: point.properties.id,
                        timestamp: point.properties.timestamp,
                        lng: point.geometry.coordinates[0],
                        lat: point.geometry.coordinates[1]
                    }))
                };

                // Initialize the worker with configuration
                console.log('Sending init message to worker...');
                worker.postMessage({
                    type: 'init',
                    config: workerData
                });

            } catch (error) {
                console.error('Error in precomputeSimulation:', error);
                this.isPrecompiling = false;
                alert('Error starting simulation: ' + error.message);
            }
        },
        playPrecomputedSimulation() {
            if (!this.simulationResults || !this.simulationResults.length) {
                console.error('No simulation results available');
                return;
            }
            
            this.isPlaying = true;
            let currentIndex = 0;
            
            const playStep = () => {
                if (!this.isPlaying || currentIndex >= this.simulationResults.length) {
                    this.isPlaying = false;
                    return;
                }

                const step = this.simulationResults[currentIndex];
                this.currentTime = step.timestamp;
                this.updateMapWithPrecomputedStep(step);
                
                currentIndex++;
                requestAnimationFrame(playStep);
            };

            playStep();
        },
        updateMapWithPrecomputedStep(step) {
            if (!this.map) return;

            const progress = (step.timestamp - this.startDate.getTime()) / 
                           (this.endDate.getTime() - this.startDate.getTime());

            // Update progress overlay (sweep effect)
            if (this.map.getSource('progress-overlay')) {
                this.map.getSource('progress-overlay').setData(this.calculateProgressPolygon(progress));
            }

            // Update observation points with flash effect
            if (this.map.getSource('observation-points')) {
                this.map.getSource('observation-points').setData({
                    type: 'FeatureCollection',
                    features: step.currentPoints
                });
            }

            // Update detected points
            if (this.map.getSource('detected-points')) {
                this.map.getSource('detected-points').setData({
                    type: 'FeatureCollection',
                    features: step.detectedPoints
                });
            }
        },
        convertToGeoJSON(points) {
            return points.map(point => ({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [point.lng, point.lat]
                },
                properties: {
                    id: point.id,
                    timestamp: point.timestamp
                }
            }));
        }
    }
}).mount('#app')
