<?php
/**
 * AlcorFields access control: who may edit which document.
 *
 *   alcor_fields_edit                 primitive: may use Site content at all. Administrators have it implicitly;
 *                                     the "Site content editor" role (a client's login) has it and nothing else
 *                                     beyond read and upload_files.
 *   alcor_fields_edit_document <key>  meta: administrators may edit every document; anyone else only the
 *                                     documents an administrator assigned to them on their user profile.
 *
 * Both the wp-admin screens and the REST routes ask the meta capability, so there is one rule, not two.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers the editor role, the meta capability and the profile screen that assigns documents.
 */
final class Alcor_Fields_Access {

	const ROLE         = 'alcor_site_editor';
	const ROLE_VERSION = 1;
	const META         = 'alcor_fields_documents';

	/**
	 * Hooks everything this class does.
	 *
	 * @return void
	 */
	public static function boot() {
		add_action( 'init', array( __CLASS__, 'ensure_role' ), 5 );
		add_filter( 'user_has_cap', array( __CLASS__, 'grant_admins' ), 10, 4 );
		add_filter( 'map_meta_cap', array( __CLASS__, 'map_meta_cap' ), 10, 4 );
		add_action( 'show_user_profile', array( __CLASS__, 'profile_fields' ) );
		add_action( 'edit_user_profile', array( __CLASS__, 'profile_fields' ) );
		add_action( 'personal_options_update', array( __CLASS__, 'save_profile_fields' ) );
		add_action( 'edit_user_profile_update', array( __CLASS__, 'save_profile_fields' ) );
		add_filter( 'login_redirect', array( __CLASS__, 'login_redirect' ), 10, 3 );
		add_filter( 'ajax_query_attachments_args', array( __CLASS__, 'own_media_only' ) );
	}

	/**
	 * Limits a client editor's media picker to the files they uploaded, not the whole site's library.
	 *
	 * @param array $query Media library query arguments.
	 * @return array The arguments, with the author fixed for a client editor.
	 */
	public static function own_media_only( $query ) {
		if ( current_user_can( 'alcor_fields_edit' ) && ! current_user_can( 'edit_others_posts' ) ) {
			$query['author'] = get_current_user_id();
		}
		return $query;
	}

	/**
	 * Creates the "Site content editor" role, and re-creates it whenever ROLE_VERSION changes.
	 *
	 * Capabilities are stored in the database, so a change to the role's list has to be written out; the version
	 * option makes that happen once per change instead of on every request.
	 *
	 * @return void
	 */
	public static function ensure_role() {
		if ( (int) get_option( 'alcor_fields_role_version' ) === self::ROLE_VERSION && get_role( self::ROLE ) ) {
			return;
		}
		remove_role( self::ROLE );
		add_role(
			self::ROLE,
			'Site content editor',
			array(
				'read'              => true,
				'upload_files'      => true,
				'alcor_fields_edit' => true,
			)
		);
		update_option( 'alcor_fields_role_version', self::ROLE_VERSION, true );
	}

	/**
	 * Gives every administrator the primitive capability without storing it on the administrator role.
	 *
	 * @param array $allcaps Capabilities the user has.
	 * @param array $caps    Capabilities being checked.
	 * @param array $args    Arguments of the check.
	 * @param mixed $user    The user.
	 * @return array The capabilities, plus alcor_fields_edit for administrators.
	 */
	public static function grant_admins( $allcaps, $caps, $args, $user ) {
		if ( ! empty( $allcaps['manage_options'] ) ) {
			$allcaps['alcor_fields_edit'] = true;
		}
		return $allcaps;
	}

	/**
	 * Maps the per-document capability to a primitive one.
	 *
	 * An unknown document key maps to do_not_allow, so a typo or a probe is refused rather than treated as "no
	 * restriction".
	 *
	 * @param string[] $caps    Primitive capabilities required.
	 * @param string   $cap     The capability being checked.
	 * @param int      $user_id The user.
	 * @param array    $args    Arguments of the check; the first is the document key.
	 * @return string[] Primitive capabilities required.
	 */
	public static function map_meta_cap( $caps, $cap, $user_id, $args ) {
		if ( 'alcor_fields_edit_document' !== $cap ) {
			return $caps;
		}
		$key = isset( $args[0] ) ? (string) $args[0] : '';
		if ( '' === $key || ! alcor_fields_document( $key ) ) {
			return array( 'do_not_allow' );
		}
		if ( user_can( $user_id, 'manage_options' ) ) {
			return array( 'alcor_fields_edit' );
		}
		return in_array( $key, self::assigned( $user_id ), true ) ? array( 'alcor_fields_edit' ) : array( 'do_not_allow' );
	}

	/**
	 * Returns the document keys assigned to a non-administrator.
	 *
	 * @param int $user_id The user.
	 * @return string[]
	 */
	public static function assigned( $user_id ) {
		$keys = get_user_meta( $user_id, self::META, true );
		return is_array( $keys ) ? array_values( array_filter( $keys, 'is_string' ) ) : array();
	}

	/**
	 * Returns the registered documents a user may edit.
	 *
	 * @param int|null $user_id The user; defaults to the current one.
	 * @return array<string, array> Documents keyed by document key.
	 */
	public static function editable_documents( $user_id = null ) {
		$user_id = $user_id ?? get_current_user_id();
		return array_filter(
			alcor_fields_documents(),
			static function ( $doc ) use ( $user_id ) {
				return user_can( $user_id, 'alcor_fields_edit_document', $doc['key'] );
			}
		);
	}

	/**
	 * Prints the "pages this person may edit" checkboxes on a client editor's profile (administrators only).
	 *
	 * @param WP_User $user The profile being shown.
	 * @return void
	 */
	public static function profile_fields( $user ) {
		if ( ! current_user_can( 'manage_options' ) || ! user_can( $user, 'alcor_fields_edit' ) || user_can( $user, 'manage_options' ) ) {
			return;
		}
		$assigned = self::assigned( $user->ID );
		wp_nonce_field( 'alcor_fields_assign_' . $user->ID, 'alcor_fields_assign_nonce' );
		echo '<h2>Site content</h2><table class="form-table" role="presentation"><tr><th scope="row">Pages this person may edit</th><td><fieldset>';
		echo '<legend class="screen-reader-text">Pages this person may edit</legend>';
		foreach ( alcor_fields_documents() as $doc ) {
			printf(
				'<label><input type="checkbox" name="alcor_fields_documents[]" value="%s"%s> %s</label><br>',
				esc_attr( $doc['key'] ),
				checked( in_array( $doc['key'], $assigned, true ), true, false ),
				esc_html( $doc['label'] )
			);
		}
		echo '<p class="description">Without a page here this person cannot edit any site content.</p></fieldset></td></tr></table>';
	}

	/**
	 * Saves the document assignment from a profile form.
	 *
	 * Needs an administrator, permission to edit that user, and the nonce printed by profile_fields(). Only keys of
	 * registered documents are kept, so a forged form cannot store anything else.
	 *
	 * @param int $user_id The profile being saved.
	 * @return void
	 */
	public static function save_profile_fields( $user_id ) {
		if ( ! current_user_can( 'manage_options' ) || ! current_user_can( 'edit_user', $user_id ) ) {
			return;
		}
		if ( ! isset( $_POST['alcor_fields_assign_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['alcor_fields_assign_nonce'] ) ), 'alcor_fields_assign_' . $user_id ) ) {
			return;
		}
		$keys  = isset( $_POST['alcor_fields_documents'] ) && is_array( $_POST['alcor_fields_documents'] ) ? wp_unslash( $_POST['alcor_fields_documents'] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- reduced to registered document keys on the next lines.
		$known = array_keys( alcor_fields_documents() );
		$keys  = array_values( array_intersect( $known, array_filter( $keys, 'is_string' ) ) );
		update_user_meta( $user_id, self::META, $keys );
	}

	/**
	 * Sends a client editor to their content after login, not to the dashboard.
	 *
	 * @param string $redirect_to The destination core chose.
	 * @param string $requested   The destination the login form asked for.
	 * @param mixed  $user        The user who logged in, or an error.
	 * @return string The destination.
	 */
	public static function login_redirect( $redirect_to, $requested, $user ) {
		if ( $user instanceof WP_User && in_array( self::ROLE, (array) $user->roles, true ) && ! user_can( $user, 'manage_options' ) ) {
			return admin_url( 'admin.php?page=alcor-fields' );
		}
		return $redirect_to;
	}
}
