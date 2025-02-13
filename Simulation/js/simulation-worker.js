console.log('Worker script loaded');

self.onerror = function(error) {
    console.error('Worker global error:', error);
};

let config = null;

console.log('Worker variables initialized');

self.onmessage = function(e) {
    console.log('Worker received message:', e.data.type);
    
    if (e.data.type === 'init') {
        try {
            const results = runSimulation(e.data.config);
            self.postMessage({ 
                type: 'complete', 
                results: results 
            });
        } catch (error) {
            self.postMessage({ 
                type: 'error', 
                error: error.toString() 
            });
        }
    }
};

function runSimulation(config) {
    // Ensure all inputs are primitive values
    const startDate = Number(config.startDate);
    const endDate = Number(config.endDate);
    const minLng = Number(config.bounds.minLng);
    const maxLng = Number(config.bounds.maxLng);
    const minLat = Number(config.bounds.minLat);
    const maxLat = Number(config.bounds.maxLat);
    const taxonomicalLikelihood = Number(config.taxonomicalLikelihood);
    const area = Number(config.area);
    
    // Generate points
    const monthsInSimulation = (endDate - startDate) / (1000 * 60 * 60 * 24 * 30);
    const observationsPerMonth = Math.ceil(area / 100);
    const totalObservations = Math.ceil(observationsPerMonth * monthsInSimulation);
    
    // Create points as a typed array for better performance and guaranteed cloning
    const observations = new Float64Array(totalObservations * 3); // lng, lat, timestamp for each point
    
    for (let i = 0; i < totalObservations; i++) {
        const idx = i * 3;
        observations[idx] = minLng + Math.random() * (maxLng - minLng);     // lng
        observations[idx + 1] = minLat + Math.random() * (maxLat - minLat); // lat
        observations[idx + 2] = startDate + Math.random() * (endDate - startDate); // timestamp
    }
    
    // Generate weekly steps
    const weekInMs = 7 * 24 * 60 * 60 * 1000;
    const steps = Math.ceil((endDate - startDate) / weekInMs);
    
    // Create results as transferable arrays
    const timeStamps = new Float64Array(steps);
    const observationCoords = new Array(steps);
    const detectionCoords = new Array(steps);
    
    for (let step = 0; step < steps; step++) {
        const currentTime = startDate + (step * weekInMs);
        const progress = step / steps;
        const spreadLng = minLng + ((maxLng - minLng) * progress);
        
        timeStamps[step] = currentTime;
        
        // Filter observations for this week
        const weekObs = [];
        const detections = [];
        
        for (let i = 0; i < totalObservations; i++) {
            const idx = i * 3;
            const timestamp = observations[idx + 2];
            
            if (timestamp <= currentTime && timestamp > currentTime - weekInMs) {
                const lng = observations[idx];
                const lat = observations[idx + 1];
                weekObs.push([lng, lat]);
                
                if (lng <= spreadLng && Math.random() * 100 <= taxonomicalLikelihood) {
                    detections.push([lng, lat]);
                }
            }
        }
        
        observationCoords[step] = weekObs;
        detectionCoords[step] = detections;
    }
    
    // Return a structured object that can be cloned
    return {
        timeStamps: Array.from(timeStamps),
        observations: observationCoords,
        detections: detectionCoords
    };
} 