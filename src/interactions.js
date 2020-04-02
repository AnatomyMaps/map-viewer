/******************************************************************************

Flatmap viewer and annotation tool

Copyright (c) 2019  David Brooks

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

******************************************************************************/

'use strict';

//==============================================================================

import {default as turfArea} from '@turf/area';
import {default as turfBBox} from '@turf/bbox';
import * as turf from '@turf/helpers';

//==============================================================================

import {ContextMenu} from './contextmenu.js';
import {LayerManager} from './layers.js';
import {QueryInterface} from './query.js';
import {ToolTip} from './tooltip.js';
import {SearchControl} from './search.js';

import * as utils from './utils.js';

//==============================================================================

function tooltip(valuesList)
function bounds(feature)
//======================
{
    const tooltipElement = document.createElement('div');
    tooltipElement.className = 'flatmap-feature-tooltip';
    for (const value of valuesList) {
        const valueElement = document.createElement('div');
        valueElement.className = 'flatmap-feature-property';
        valueElement.textContent = value;
        tooltipElement.appendChild(valueElement);
    // Find the feature's bounding box

    let bounds = ('bounds' in feature.properties) ? feature.properties.bounds
                                                  : feature.properties.bbox;
    if (bounds) {
        // Bounding box is defined in GeoJSON

        return JSON.parse(bounds);
    } else {
        // Get the bounding box of the current polygon. This won't neccessary
        // be the full feature because of tiling

        const polygon = turf.geometry(feature.geometry.type, feature.geometry.coordinates);
        return turfBBox(polygon);
    }
    return tooltipElement;
}

//==============================================================================

function expandBounds(bbox1, bbox2)
//=================================
{
    return [Math.min(bbox1[0], bbox2[0]), Math.min(bbox1[1], bbox2[1]),
            Math.max(bbox1[2], bbox2[2]), Math.max(bbox1[3], bbox2[3])
           ];
}

//==============================================================================

export class UserInteractions
{
    constructor(flatmap, userInterfaceLoadedCallback=null)
    {
        this._flatmap = flatmap;
        this._map = flatmap.map;
        this._userInterfaceLoadedCallback =  userInterfaceLoadedCallback;
        this._queryInterface = new QueryInterface(flatmap.id);

        this._selectedFeature = null;
        this._highlightedFeatures = [];

        this._inQuery = false;
        this._modal = false;

        // Fit the map to our window

        flatmap.fitBounds();

        // Add a control to search annotations if option set

        if (flatmap.options.searchable) {
            this._map.addControl(new SearchControl(flatmap.searchIndex));
        }



         // Manage our layers

        this._layerManager = new LayerManager(flatmap);

        // Add the map's layers

        // Layers have an id, either layer-N or an assigned name
        // Some layers might have a description. These are the selectable layers,
        // unless they are flagged as `no-select`
        // Selectable layers have opacity 0 unless active, in which case they have opacity 1.
        // `no-select` layers have opacity 0.5
        // Background layer has opacity 0.2

        const layersById = new Map();
        const layerBackgroundIds = [];
        for (const layer of flatmap.layers) {
            layer.backgroundLayers = [];
            layersById.set(layer.id, layer);
        }
        for (const layer of flatmap.layers) {
            if (layer.background_for) {
                const l = layersById.get(layer.background_for);
                l.backgroundLayers.push(layer);
                layerBackgroundIds.push(layer.id);
            }
        }
        for (const layer of flatmap.layers) {
            if (layerBackgroundIds.indexOf(layer.id) < 0) {
                this._layerManager.addLayer(layer);
            }
        }

        // Flag features that have annotations
        // Also flag those features that are models of something

        for (const [id, ann] of flatmap.annotations) {
            const feature = utils.mapFeature(ann.layer, id);
            this._map.setFeatureState(feature, { 'annotated': true });
            if ('error' in ann) {
                this._map.setFeatureState(feature, { 'annotation-error': true });
                console.log(`Annotation error, ${ann.layer}: ${ann.error} (${ann.text})`);
            }
        }

        // Display a tooltip at the mouse pointer

        this._tooltip = new ToolTip(flatmap);
        this._map.on('mousemove', this.mouseMoveEvent_.bind(this));

        // Display a context menu on right-click

        this._lastContextTime = 0;
        this._contextMenu = new ContextMenu(flatmap, this.contextMenuClosed_.bind(this));
        this._map.on('contextmenu', this.contextMenuEvent_.bind(this));

        // Display a context menu with a touch longer than 0.5 second

        this._lastTouchTime = 0;
        this._map.on('touchstart', (e) => { this._lastTouchTime = Date.now(); });
        this._map.on('touchend', (e) => {
            if (Date.now() > (this._lastTouchTime + 500)) {
                this.contextMenuEvent_(e);
            }
        });

        // Handle mouse click events

        this._map.on('click', this.clickEvent_.bind(this));

        if (this._userInterfaceLoadedCallback !== null) {
            this._userInterfaceLoadedCallback(this);
            this._userInterfaceLoadedCallback = null;
        }
    }

    layerSwitcherActiveCallback_(layerSwitcher)
    //=========================================
    {
        if (this._userInterfaceLoadedCallback !== null) {
            this._userInterfaceLoadedCallback(this);
            this._userInterfaceLoadedCallback = null;
        }
    }

    getState()
    //========
    {
        // Return the map's centre, zoom, and active layers
        // Can only be called when the map is fully loaded
        return {
            center: this._map.getCenter().toArray(),
            zoom: this._map.getZoom(),
            layers: this.activeLayerNames
        };
    }

    setState(state)
    //=============
    {
        // Restore the map to a saved state
        const options = {};
        if ('center' in state) {
            options['center'] = state.center;
        }
        if ('zoom' in state) {
            options['zoom'] = state.zoom;
            options['around'] = [0, 0];
        }
        if (Object.keys(options).length > 0) {
            this._map.jumpTo(options);
        }
    }

    get activeLayerNames()
    //====================
    {
        return this._layerManager.activeLayerNames;
    }

    get activeLayerIds()
    //==================
    {
        const mapLayers = [];
        for (const name of this._layerManager.activeLayerNames) {
            mapLayers.push(this._flatmap.mapLayerId(name));
        }
        return mapLayers;
    }

    activateLayer(layerId)
    //====================
    {
        this._layerManager.activate(layerId);
    }

    activateLayers(layerIds)
    //======================
    {
        for (const layerId of layerIds) {
            this.activateLayer(layerId);
        }
    }

    deactivateLayer(layerId)
    //======================
    {
        this._layerManager.deactivate(layerId);
    }

    deactivateLayers()
    //================
    {
        for (const layerId of this.activeLayerIds) {
            this.deactivateLayer(layerId);
        }
    }

    selectFeature_(feature)
    //=====================
    {
        this.unselectFeatures_(false);
        this._map.setFeatureState(feature, { "selected": true })
        this._selectedFeature = feature;
    }

    unselectFeatures_(reset=true)
    //===========================
    {
        if (this._selectedFeature !== null) {
            this._map.removeFeatureState(this._selectedFeature, "selected");
            if (reset) {
                this._selectedFeature = null;
            }
        }
    }

    get selectedFeatureLayerName()
    //============================
    {
        if (this._selectedFeature !== null) {
            const layerId = this._selectedFeature.layer.id;
            if (layerId.includes('-')) {
                return layerId.split('-').slice(0, -1).join('-')
            } else {
                return layerId;
            }
        }
        return null;
    }

    unhighlightFeatures_(reset=true)
    //==============================
    {
        for (const feature of this._highlightedFeatures) {
            this._map.removeFeatureState(feature, "highlighted");
        }
        this._highlightedFeatures = [];
    }

    activeFeaturesAtEvent_(event)
    //===========================
    {
        // Get the features covering the event's point that are in the active layers

        return this._map.queryRenderedFeatures(event.point).filter(f => {
            return (this.activeLayerNames.indexOf(f.sourceLayer) >= 0)
                && ('id' in f.properties);
            }
        );
    }

    smallestAnnotatedPolygonFeature_(features)
    //========================================
    {
        // Get the smallest feature from a list of features

        let smallestArea = 0;
        let smallestFeature = null;
        for (const feature of features) {
            if (feature.geometry.type.includes('Polygon')
             && this._map.getFeatureState(feature)['annotated']) {
                const polygon = turf.geometry(feature.geometry.type, feature.geometry.coordinates);
                const area = turfArea(polygon);
                if (smallestFeature === null || smallestArea > area) {
                    smallestFeature = feature;
                    smallestArea = area;
                }
            }
        }
        return smallestFeature;
    }

    smallestAnnotatedPolygonAtEvent_(event)
    //=====================================
    {
        // Get the smallest polygon feature covering the event's point

        return this.smallestAnnotatedPolygonFeature_(this.activeFeaturesAtEvent_(event));
    }

    showTooltip_(position, feature)
    //=============================
    {
        let result = false;
        const id = feature.properties.id;
        const ann = this._flatmap.getAnnotation(id);
        this.selectFeature_(feature);
        if (this.annotating) {
            if (ann) {
                const error = ('error' in ann) ? ann.error : '';
                this._tooltip.show(position, tooltip([ann.featureId, ann.label, ...ann.text.split(/\s+/), error]));
            } else {
                this._tooltip.show(position, tooltip([id, this._map.getFeatureState(feature)['annotated']]));
            }
            result = true;
        } else if (ann) {
            const models = ann.models;
            if (models.length) {
                this._tooltip.show(position, tooltip([ann.label ? ann.label: models[0]]));
                result = true;
            } else if (this._layerManager.layerQueryable(ann.layer)) {
                result = true;
            }
        }
        if (result && !this._inQuery) {
            this._map.getCanvas().style.cursor = 'pointer';
        }
        return result;
    }

    mouseMoveEvent_(event)
    //====================
    {
        if (this._modal) {
            return;
        }
        const features = this.activeFeaturesAtEvent_(event);
        let feature = this.smallestAnnotatedPolygonFeature_(features);
        if (feature === null && this.annotating && features.length) {
            feature = features[0];
        }

        if (feature === null || !this.showTooltip_(event.lngLat, feature)) {
            if (!this._inQuery) {
                this._map.getCanvas().style.cursor = '';
            }
            this._tooltip.hide();
            this.unselectFeatures_();
        }
    }

    contextMenuEvent_(event)
    //======================
    {
        event.preventDefault();

        // Chrome on Android sends both touch and contextmenu events
        // so ignore duplicate

        if (Date.now() < (this._lastContextTime + 100)) {
            return;
        }
        this._lastContextTime = Date.now();

        const features = this.activeFeaturesAtEvent_(event);
        let feature = this.smallestAnnotatedPolygonFeature_(features);
        if (feature !== null) {
            const id = feature.properties.id;
            const ann = this._flatmap.getAnnotation(id);
            this.selectFeature_(feature);
            this._tooltip.hide();
            const items = [];
            if (ann) {
                if (ann.models.length > 0) {
                    items.push({
                        id: id,
                        prompt: `Search for knowledge about node`,
                        action: this.query_.bind(this, 'data')
                    });
                }
                if (this._layerManager.layerQueryable(ann.layer)) {
                    items.push({
                        id: id,
                        prompt: 'Find edges connected to node',
                        action: this.query_.bind(this, 'edges')
                    });
                    items.push({
                        id: id,
                        prompt: 'Find nodes and edges connected to node',
                        action: this.query_.bind(this, 'nodes')
                    });
                }
            }
            if (items.length) {
                items.push('-');
            }
            items.push({
                id: id,
                prompt: 'Zoom to...',
                action: this.zoomTo_.bind(this, feature)
            });
            if (items.length) {
                this._modal = true;
                this._contextMenu.show(event.lngLat, items);
                return;
            }
        }
    }

    contextMenuClosed_(event)
    //=======================
    {
        this._modal = false;
    }

    zoomTo_(feature)
    //==============
    {
        this._contextMenu.hide();

        // Zoom map to feature

        this._map.fitBounds(bounds(feature), {
            padding: 100,
            animate: false
        });
    }

    zoomToFeatures(featureIds)
    //========================
    {
        this.unhighlightFeatures_();

        if (featureIds.length) {

            const featureIdFilter = ['in', 'id'];
            featureIdFilter.splice(2, 0, ...featureIds);
            const features = this._map.queryRenderedFeatures(null, {
                filter: featureIdFilter
            });
            if (features.length) {
                let bbox = null;
                for (const feature of features) {
                    this._map.setFeatureState(feature, { 'highlighted': true });
                    this._highlightedFeatures.push(feature);
                    bbox = (bbox === null) ? bounds(feature)
                                           : expandBounds(bbox, bounds(feature));
                }

                // Zoom map to features

                this._map.fitBounds(bbox, {
                    padding: 100,
                    animate: false
                });
            }
        }
    }

    clearResults()
    //============
    {
        this.unhighlightFeatures_();
    }

    queryData_(modelList)
    //===================
    {
        if (modelList.length > 0) {
            this._flatmap.callback('query-data', modelList, {
                describes: this._flatmap.describes
            });
        }
    }

    query_(type, event)
    //=================
    {
        this.unhighlightFeatures_();
        this._contextMenu.hide();
        const featureId = event.target.getAttribute('id');
        if (type === 'data') {
            this.queryData_(this._flatmap.modelsForFeature(featureId));
        } else {
            const ann = this._flatmap.getAnnotation(featureId);
            this._queryInterface.query(type, ann.url, ann.models);
            this._map.getCanvas().style.cursor = 'progress';
            this._inQuery = true;
        }
        this._modal = false;
    }

    clickEvent_(event)
    //================
    {
        this._layerSwitcher.close();
        const feature = this.smallestAnnotatedPolygonAtEvent_(event);
        if (feature !== null) {
            const featureId = feature.properties.id;
            this.selectFeature_(feature);
            this.queryData_(this._flatmap.modelsForFeature(featureId));
        }
        this.unhighlightFeatures_();
    }
}

//==============================================================================
