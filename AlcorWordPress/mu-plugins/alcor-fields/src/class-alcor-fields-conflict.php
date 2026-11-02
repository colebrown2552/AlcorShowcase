<?php
/**
 * AlcorFields version conflict.
 *
 * Thrown when a write names a version that is no longer the current one, or loses a race against another write.
 * The REST API maps it to HTTP 409; the editor screen shows its message and keeps the editor's changes.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The document changed since the caller read it.
 */
final class Alcor_Fields_Conflict extends RuntimeException {
}
