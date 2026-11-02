<?php
/**
 * AlcorFields storage.
 *
 * One option row per document holds the published content, an optional draft and the last 20 published versions.
 * Every write is a compare-and-swap on that single row, and every caller must name the version it edited, so two
 * people saving at once get a conflict instead of silently overwriting each other.
 *
 * Stored content is always the sparse, validated form from Alcor_Fields_Template::validate(): only the values that
 * differ from the template, plus hidden optional sections.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Reads and writes document state.
 */
final class Alcor_Fields_Store {

	const FORMAT  = 'alcor.fields.state.v1';
	const HISTORY = 20;

	/**
	 * Returns the option name that holds a document.
	 *
	 * @param string $key Document key.
	 * @return string
	 */
	public static function option( $key ) {
		return 'alcor_fields_' . $key;
	}

	/**
	 * Returns the state of a document that has never been saved.
	 *
	 * @return array
	 */
	private static function empty_state() {
		return array(
			'format'    => self::FORMAT,
			'version'   => 0,
			'published' => null,
			'draft'     => null,
			'history'   => array(),
		);
	}

	/**
	 * Reads the current state of a document.
	 *
	 * @param string $key   Document key.
	 * @param bool   $fresh True to read past the object cache. Use it before showing an editor the version to edit.
	 * @return array State: format, version, published, draft and history.
	 * @throws RuntimeException When the stored row is damaged.
	 */
	public static function load( $key, $fresh = false ) {
		global $wpdb;
		if ( $fresh ) {
			$raw = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::option( $key ) ) );
		} else {
			$raw = get_option( self::option( $key ), null );
		}
		return self::decode( $raw );
	}

	/**
	 * Decodes a stored row.
	 *
	 * @param mixed $raw The option value.
	 * @return array State.
	 * @throws RuntimeException When the row is not a state this plugin wrote.
	 */
	private static function decode( $raw ) {
		if ( ! is_string( $raw ) || '' === $raw ) {
			return self::empty_state();
		}
		$state = json_decode( $raw, true );
		if ( ! is_array( $state ) || self::FORMAT !== ( $state['format'] ?? '' ) || ! is_int( $state['version'] ?? null ) ) {
			// Never guess at a damaged row: render as authored and refuse writes until an administrator resets it.
			throw new RuntimeException( 'AlcorFields state for this document is unreadable' );
		}
		return $state + self::empty_state();
	}

	/**
	 * Applies $change to the state at $base_version and writes it atomically.
	 *
	 * The UPDATE matches on the exact text that was read, so if anything wrote in between, zero rows change and the
	 * caller gets a conflict. That is what makes "the document moved on" detectable without a lock.
	 *
	 * @param string   $key          Document key.
	 * @param int      $base_version The version the caller edited.
	 * @param callable $change       Function that takes the state and returns the new state.
	 * @return array The new state.
	 * @throws Alcor_Fields_Conflict When the document moved past $base_version, or another write won the race.
	 */
	public static function update( $key, $base_version, callable $change ) {
		global $wpdb;
		$name  = self::option( $key );
		$raw   = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $name ) );
		$state = self::decode( $raw );
		if ( (int) $base_version !== $state['version'] ) {
			throw new Alcor_Fields_Conflict( 'This content changed since you opened it (now version ' . $state['version'] . ', you edited version ' . (int) $base_version . ').' );
		}
		$next            = $change( $state );
		$next['format']  = self::FORMAT;
		$next['version'] = $state['version'] + 1;
		$next['history'] = array_slice( $next['history'] ?? array(), 0, self::HISTORY );
		$encoded         = wp_json_encode( $next, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( ! is_string( $encoded ) ) {
			throw new RuntimeException( 'AlcorFields could not encode the document' );
		}
		if ( null === $raw ) {
			$written = add_option( $name, $encoded, '', false );
		} else {
			$written = 1 === $wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s", $encoded, $name, $raw ) );
		}
		wp_cache_delete( $name, 'options' );
		wp_cache_delete( 'notoptions', 'options' );
		wp_cache_delete( 'alloptions', 'options' );
		if ( ! $written ) {
			throw new Alcor_Fields_Conflict( 'Someone saved this content at the same moment. Reload to see their version.' );
		}
		do_action( 'alcor_fields_saved', $key, $next );
		return $next;
	}

	/**
	 * Wraps validated content with the facts recorded at save time.
	 *
	 * @param array                 $doc      Validated content: values and hidden.
	 * @param Alcor_Fields_Template $template The template the content was validated against.
	 * @param string                $note     Optional note shown in the version history.
	 * @return array Content plus template hash, time, user, note, field signatures and a content hash.
	 */
	private static function stamp( array $doc, Alcor_Fields_Template $template, $note = '' ) {
		$doc = array(
			'values' => $doc['values'],
			'hidden' => $doc['hidden'],
		);
		return $doc + array(
			'template_sha256' => $template->sha256,
			'saved_at'        => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'saved_by'        => get_current_user_id(),
			'note'            => $note,
			// What type each field had when this was saved, so a later design change can be told apart from bad data.
			'signatures'      => $template->signatures(),
			'sha256'          => hash( 'sha256', wp_json_encode( array( $doc['values'], $doc['hidden'] ), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) ),
		);
	}

	/**
	 * Tells whether the row exists but cannot be read (corrupt or foreign data).
	 *
	 * @param string $key Document key.
	 * @return bool
	 */
	public static function unreadable( $key ) {
		try {
			self::load( $key, true );
			return false;
		} catch ( RuntimeException $e ) {
			return true;
		}
	}

	/**
	 * Moves an unreadable row aside so the document starts from its template again.
	 *
	 * The damaged copy is kept as its own option (alcor_fields_quarantine_<key>_<time>, never autoloaded) for
	 * inspection; nothing is deleted without a copy.
	 *
	 * @param string $key Document key.
	 * @return string The new option name, or '' when the row was readable or missing.
	 */
	public static function quarantine( $key ) {
		global $wpdb;
		$name = self::option( $key );
		$raw  = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $name ) );
		if ( null === $raw || ! self::unreadable( $key ) ) {
			return '';
		}
		$kept = 'alcor_fields_quarantine_' . $key . '_' . gmdate( 'YmdHis' );
		add_option( $kept, $raw, '', false );
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value = %s", $name, $raw ) );
		wp_cache_delete( $name, 'options' );
		wp_cache_delete( 'notoptions', 'options' );
		wp_cache_delete( 'alloptions', 'options' );
		return $kept;
	}

	/**
	 * Saves validated content as the draft. The live page does not change.
	 *
	 * @param string $key          Document key.
	 * @param int    $base_version The version the caller edited.
	 * @param array  $clean        Validated content: values and hidden.
	 * @param string $note         Optional note.
	 * @return array The new state.
	 * @throws Alcor_Fields_Conflict When the document moved past $base_version.
	 */
	public static function save_draft( $key, $base_version, array $clean, $note = '' ) {
		$template = alcor_fields_template( $key );
		return self::update(
			$key,
			$base_version,
			static function ( $state ) use ( $clean, $template, $note ) {
				$state['draft'] = self::stamp( $clean, $template, $note );
				return $state;
			}
		);
	}

	/**
	 * Publishes $clean, or the current draft when $clean is null. The new version is added to history.
	 *
	 * @param string      $key          Document key.
	 * @param int         $base_version The version the caller edited.
	 * @param array|null  $clean        Validated content, or null to publish the draft.
	 * @param string      $note         Optional note.
	 * @return array The new state.
	 * @throws Alcor_Fields_Conflict When the document moved on, or there is no draft to publish.
	 */
	public static function publish( $key, $base_version, $clean = null, $note = '' ) {
		$template = alcor_fields_template( $key );
		return self::update(
			$key,
			$base_version,
			static function ( $state ) use ( $clean, $template, $note ) {
				if ( null === $clean ) {
					if ( ! $state['draft'] ) {
						throw new Alcor_Fields_Conflict( 'There is no draft to publish.' );
					}
					// Published exactly as the editor screen shows it: repaired against today's design if that changed.
					$repaired = $template->validate_stored( $state['draft'], alcor_fields_env() );
					$clean    = array(
						'values' => $repaired['values'],
						'hidden' => $repaired['hidden'],
					);
					$note     = '' !== $note ? $note : (string) ( $state['draft']['note'] ?? '' );
				}
				$published                = self::stamp( $clean, $template, $note );
				$published['version']     = $state['version'] + 1;
				$state['published']       = $published;
				$state['draft']           = null;
				array_unshift( $state['history'], $published );
				return $state;
			}
		);
	}

	/**
	 * Throws the draft away. The live page does not change.
	 *
	 * @param string $key          Document key.
	 * @param int    $base_version The version the caller edited.
	 * @return array The new state.
	 * @throws Alcor_Fields_Conflict When the document moved past $base_version.
	 */
	public static function discard_draft( $key, $base_version ) {
		return self::update(
			$key,
			$base_version,
			static function ( $state ) {
				$state['draft'] = null;
				return $state;
			}
		);
	}

	/**
	 * Copies a published version from history into the draft, repaired against today's design if that changed.
	 *
	 * @param string $key          Document key.
	 * @param int    $base_version The version the caller edited.
	 * @param int    $version      The published version to bring back.
	 * @return array The new state.
	 * @throws Alcor_Fields_Conflict When the document moved on, or $version is not in the history.
	 */
	public static function restore( $key, $base_version, $version ) {
		$template = alcor_fields_template( $key );
		return self::update(
			$key,
			$base_version,
			static function ( $state ) use ( $template, $version ) {
				foreach ( $state['history'] as $entry ) {
					if ( (int) ( $entry['version'] ?? 0 ) !== (int) $version ) {
						continue;
					}
					$repaired       = $template->validate_stored( $entry, alcor_fields_env() );
					$note           = 'Restored from version ' . (int) $version
						. ( $repaired['dropped'] ? ' (' . count( $repaired['dropped'] ) . ' value(s) no longer fit the design and show the original)' : '' );
					$state['draft'] = self::stamp(
						array(
							'values' => $repaired['values'],
							'hidden' => $repaired['hidden'],
						),
						$template,
						$note
					);
					return $state;
				}
				throw new Alcor_Fields_Conflict( 'Version ' . (int) $version . ' is not in the history.' );
			}
		);
	}
}
