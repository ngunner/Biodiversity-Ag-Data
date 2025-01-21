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
            bounds: {
                minLng: -79.76,
                maxLng: -71.85,
                minLat: 40.49,
                maxLat: 45.01
            },
            updateTimeout: null,
            isDragging: false
        }
    },
    computed: {
        detectionRate() {
            if (this.totalObservationCount === 0) return 0;
            return ((this.detectedPoints.size / this.totalObservationCount) * 100).toFixed(1);
        }
    },
    mounted() {
        this.map = new maplibregl.Map({
            container: 'map',
            style: 'https://demotiles.maplibre.org/style.json',
            center: [-75.6, 42.9],
            zoom: 6
        });

        this.map.on('load', () => {
            // Add NY boundary source with correct path
            this.map.addSource('ny-boundary', {
                'type': 'geojson',
                'data': './assets/ny-state.geojson'
            });

            // Add NY boundary layer
            this.map.addLayer({
                'id': 'ny-boundary-line',
                'type': 'line',
                'source': 'ny-boundary',
                'paint': {
                    'line-color': '#000',
                    'line-width': 1
                }
            });

            // Add progress overlay source
            this.map.addSource('progress-overlay', {
                'type': 'geojson',
                'data': this.calculateProgressPolygon(0)
            });

            // Add observation points source
            this.map.addSource('observation-points', {
                'type': 'geojson',
                'data': {
                    type: 'FeatureCollection',
                    features: []
                }
            });

            // Add detected points source
            this.map.addSource('detected-points', {
                'type': 'geojson',
                'data': {
                    type: 'FeatureCollection',
                    features: []
                }
            });

            // Add layers
            this.map.addLayer({
                'id': 'progress-fill',
                'type': 'fill',
                'source': 'progress-overlay',
                'paint': {
                    'fill-color': '#FF0000',
                    'fill-opacity': 0.1
                }
            });

            this.map.addLayer({
                'id': 'observation-points',
                'type': 'circle',
                'source': 'observation-points',
                'paint': {
                    'circle-radius': 4,
                    'circle-color': '#666666'
                }
            });

            this.map.addLayer({
                'id': 'detected-points',
                'type': 'circle',
                'source': 'detected-points',
                'paint': {
                    'circle-radius': 4,
                    'circle-color': '#FF0000'
                }
            });

            // Generate initial points
            this.generatePotentialPoints();
        });
    },
    methods: {
        calculateProgressPolygon(progress) {
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
        toggleAnimation() {
            // Don't allow restart if complete - must reset first
            if (this.simulationComplete && !this.isPlaying) {
                return;
            }

            this.isPlaying = !this.isPlaying;
            if (this.isPlaying) {
                this.animate();
            } else {
                cancelAnimationFrame(this.animationFrame);
            }
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
            // Clear existing points
            this.observationPoints = [];
            this.currentPoints = [];
            this.detectedPoints = new Set();
            
            // Calculate dimensions
            const width = (this.bounds.maxLng - this.bounds.minLng) * 111 * Math.cos(42.9 * Math.PI / 180); // km
            const height = (this.bounds.maxLat - this.bounds.minLat) * 111; // km
            
            // Calculate grid size for 100km²
            const gridSize = 10; // 10km x 10km = 100km²
            const numCols = Math.ceil(width / gridSize);
            const numRows = Math.ceil(height / gridSize);
            
            // Calculate total months
            const totalMonths = Math.ceil((this.endDate - this.startDate) / (1000 * 60 * 60 * 24 * 30.44));

            // For each grid cell
            for (let row = 0; row < numRows; row++) {
                for (let col = 0; col < numCols; col++) {
                    // Calculate cell bounds
                    const cellMinLng = this.bounds.minLng + (col * gridSize / (111 * Math.cos(42.9 * Math.PI / 180)));
                    const cellMaxLng = this.bounds.minLng + ((col + 1) * gridSize / (111 * Math.cos(42.9 * Math.PI / 180)));
                    const cellMinLat = this.bounds.minLat + (row * gridSize / 111);
                    const cellMaxLat = this.bounds.minLat + ((row + 1) * gridSize / 111);

                    // For each month
                    for (let month = 0; month < totalMonths; month++) {
                        // Generate observations for this cell this month
                        for (let obs = 0; obs < this.observationDensity; obs++) {
                            const monthStart = new Date(this.startDate);
                            monthStart.setMonth(monthStart.getMonth() + month);
                            const monthEnd = new Date(monthStart);
                            monthEnd.setMonth(monthEnd.getMonth() + 1);

                            const point = {
                                type: 'Feature',
                                geometry: {
                                    type: 'Point',
                                    coordinates: [
                                        cellMinLng + Math.random() * (cellMaxLng - cellMinLng),
                                        cellMinLat + Math.random() * (cellMaxLat - cellMinLat)
                                    ]
                                },
                                properties: {
                                    id: this.observationPoints.length,
                                    timestamp: monthStart.getTime() + Math.random() * (monthEnd - monthStart)
                                }
                            };
                            this.observationPoints.push(point);
                        }
                    }
                }
            }

            // Sort points by timestamp
            this.observationPoints.sort((a, b) => a.properties.timestamp - b.properties.timestamp);
        },
        resetSimulation() {
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

            this.generatePotentialPoints();
        }
    }
}).mount('#app')
