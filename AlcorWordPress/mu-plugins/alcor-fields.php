<?php
/**
 * Plugin Name: AlcorFields
 * Description: Loads AlcorFields (mu-plugins/alcor-fields/): client-editable page content declared by data-af-* annotations in the page template, with typed validation, drafts, preview, history, REST and JSON hand-off.
 * Version: 1.0.0
 * Author: Alcor Industries
 *
 * WordPress loads only the top-level files of the mu-plugins folder, so this one-line loader pulls in the plugin
 * that lives in the subfolder.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

require_once __DIR__ . '/alcor-fields/alcor-fields.php';
